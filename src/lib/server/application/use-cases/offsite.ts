/**
 * Sauvegardes hors serveur (Cloudflare R2) : Forge s'en occupe seul.
 *   • base de Forge : toutes les heures (copie cohérente SQLite) ;
 *   • bases des projets : chaque jour (pg_dump / mysqldump dans le CT, sans rien y laisser) ;
 *   • rétention 7 j / 4 sem. / 5 mois (16 copies max), puis test de restauration tous les 30 jours.
 * Tout est chiffré par restic avant l'envoi. Les écritures passent par le garde (DRY_RUN).
 */
import { gunzipSync } from 'node:zlib';
import { isSqlDbKind } from '$lib/domain/compose-analysis';
import { backupName } from '$lib/domain/database';
import { errorMessage, UserFacingError } from '$lib/domain/errors';
import {
	FORGE_DB_PATH,
	OFFSITE_FORGE_EVERY_MS,
	OFFSITE_MAX_DUMP_BYTES,
	OFFSITE_PROJECTS_EVERY_MS,
	OFFSITE_RESTORE_TEST_EVERY_MS,
	projectDbPath,
	resticRepository,
	type OffsiteSnapshot
} from '$lib/domain/offsite';
import type { ProjectRow } from '$server/infrastructure/db/schema';
import { DbCommand, type OffsiteGateway } from '../gateways';
import { dbLocation } from '../jobs/steps/database';
import type { ForgeServices } from '../services';

interface RunState {
	at: number;
	ok: boolean;
	simulated?: boolean;
	error?: string;
	bytes?: number;
}

export interface OffsiteState {
	forge?: RunState;
	projects?: RunState & { failed?: string[] };
	perProject?: Record<string, RunState>;
	prune?: RunState;
	restoreTest?: RunState;
}

export interface OffsiteDeps {
	gateway: OffsiteGateway;
	/** Copie cohérente de la base SQLite de Forge (sqlite backup API). */
	snapshotForgeDb: () => Promise<Buffer>;
	/** Vérifie qu'une copie de la base de Forge s'ouvre et est intègre. */
	verifyForgeDb: (data: Buffer) => string | null;
}

export class OffsiteBackupService {
	#running = false;

	constructor(
		private readonly s: ForgeServices,
		private readonly d: OffsiteDeps
	) {}

	configured(): boolean {
		const g = (k: Parameters<typeof this.s.settings.get>[0]) => this.s.settings.get(k);
		if (!g('offsite.endpoint') || !g('offsite.bucket') || !g('offsite.accessKeyId') || !this.s.settings.has('offsite.secretAccessKey')) return false;
		try {
			resticRepository({ endpoint: g('offsite.endpoint'), bucket: g('offsite.bucket') });
			return true;
		} catch {
			return false;
		}
	}

	state(): OffsiteState {
		try {
			return JSON.parse(this.s.settings.get('offsite.state')) as OffsiteState;
		} catch {
			return {};
		}
	}

	#save(patch: Partial<OffsiteState>) {
		this.s.settings.set({ 'offsite.state': JSON.stringify({ ...this.state(), ...patch }) });
	}

	#result(start: number, extra: Partial<RunState> = {}): RunState {
		return { at: start, ok: true, simulated: this.s.guard.isDryRun() || undefined, ...extra };
	}

	/** Appelé toutes les heures : ne fait que ce qui est dû. */
	async tick(force = false): Promise<string[]> {
		if (!this.configured() || this.#running) return [];
		this.#running = true;
		const done: string[] = [];
		try {
			await this.d.gateway.ensureRepository();
			const st = this.state();
			const due = (r: RunState | undefined, every: number) => force || !r || !r.ok || Date.now() - r.at >= every;
			if (due(st.forge, OFFSITE_FORGE_EVERY_MS)) {
				await this.backupForge();
				done.push('base de Forge');
			}
			if (due(st.projects, OFFSITE_PROJECTS_EVERY_MS)) {
				const n = await this.backupProjects();
				done.push(`${n} base(s) de projet`);
				await this.prune();
			}
			if (due(this.state().restoreTest, OFFSITE_RESTORE_TEST_EVERY_MS)) {
				await this.restoreTest();
				done.push('test de restauration');
			}
		} catch (err) {
			// Échec global (R2 injoignable, clé refusée…) : noté sur la base de Forge, visible dans Santé.
			this.#save({ forge: { at: Date.now(), ok: false, error: errorMessage(err) } });
			throw err;
		} finally {
			this.#running = false;
		}
		return done;
	}

	async backupForge(): Promise<void> {
		const start = Date.now();
		try {
			const data = await this.d.snapshotForgeDb();
			await this.d.gateway.backup(FORGE_DB_PATH, data, ['forge']);
			this.#save({ forge: this.#result(start, { bytes: data.length }) });
		} catch (err) {
			this.#save({ forge: { at: start, ok: false, error: errorMessage(err) } });
			throw err;
		}
	}

	#withDb(): ProjectRow[] {
		return this.s.repos.projects.list().filter((p) => p.ip && p.dbService && isSqlDbKind(p.dbKind));
	}

	/** Dump de la base d'un projet, lu par SSH puis envoyé chiffré. */
	async backupProject(p: ProjectRow): Promise<RunState> {
		const start = Date.now();
		try {
			const loc = dbLocation(p);
			const res = await this.s.shell.dbRead({ ip: p.ip!, sshHostKey: p.sshHostKey }, DbCommand.exportDump(loc, OFFSITE_MAX_DUMP_BYTES), 30 * 60_000);
			if (res.code !== 0) throw new Error(res.stderr.trim().slice(-300) || `code ${res.code}`);
			const [sizeLine = '0', b64 = ''] = res.stdout.split('\n');
			if (Number(sizeLine) > OFFSITE_MAX_DUMP_BYTES) throw new Error(`dump trop gros (${Math.round(Number(sizeLine) / 1024 ** 2)} Mo)`);
			const data = Buffer.from(b64.trim(), 'base64');
			if (data.length === 0 || data.length !== Number(sizeLine)) throw new Error('dump vide ou tronqué');
			await this.d.gateway.backup(projectDbPath(p.slug), data, [`project:${p.slug}`]);
			return this.#result(start, { bytes: data.length });
		} catch (err) {
			return { at: start, ok: false, error: errorMessage(err) };
		}
	}

	async backupProjects(): Promise<number> {
		const start = Date.now();
		const per: Record<string, RunState> = { ...this.state().perProject };
		const failed: string[] = [];
		let n = 0;
		for (const p of this.#withDb()) {
			const r = await this.backupProject(p);
			per[p.slug] = r;
			if (r.ok) n++;
			else failed.push(p.slug);
		}
		this.#save({ perProject: per, projects: failed.length ? { at: start, ok: false, failed, error: `Échec : ${failed.join(', ')}` } : this.#result(start) });
		return n;
	}

	async prune(): Promise<void> {
		const start = Date.now();
		try {
			await this.d.gateway.prune();
			this.#save({ prune: this.#result(start) });
		} catch (err) {
			this.#save({ prune: { at: start, ok: false, error: errorMessage(err) } });
		}
	}

	/** Rapatrie la dernière copie de Forge et un dump de projet, et vérifie qu'ils sont lisibles. */
	async restoreTest(): Promise<void> {
		const start = Date.now();
		try {
			const snaps = await this.d.gateway.snapshots();
			const forge = snaps.find((x) => x.path === FORGE_DB_PATH);
			if (!forge) throw new Error(this.s.guard.isDryRun() ? 'aucune copie (DRY_RUN : rien n’est envoyé)' : 'aucune copie de la base de Forge');
			const err = this.d.verifyForgeDb(await this.d.gateway.dump(forge.id, FORGE_DB_PATH, OFFSITE_MAX_DUMP_BYTES));
			if (err) throw new Error(`base de Forge illisible : ${err}`);
			const proj = snaps.find((x) => x.path.startsWith('/project-'));
			if (proj) {
				const sql = gunzipSync(await this.d.gateway.dump(proj.id, proj.path, OFFSITE_MAX_DUMP_BYTES)).toString('utf8', 0, 4096);
				if (!/(PostgreSQL|MySQL|MariaDB) dump|^--/m.test(sql)) throw new Error(`dump ${proj.path.slice(1)} illisible`);
			}
			this.#save({ restoreTest: { at: start, ok: true } });
		} catch (err) {
			this.#save({ restoreTest: { at: start, ok: false, error: errorMessage(err) } });
		}
	}

	/** Toutes les copies du dépôt, plus récentes d'abord (lecture). */
	async all(): Promise<OffsiteSnapshot[]> {
		if (!this.configured() || !(await this.d.gateway.initialized())) return [];
		return (await this.d.gateway.snapshots()).sort((a, b) => b.time - a.time);
	}

	/**
	 * Téléchargement d'une copie, déchiffrée (restic dump). Lecture seule : rien n'est écrit,
	 * ni sur R2 ni sur le serveur. Réservé à l'admin (route non listée dans access.ts).
	 */
	async download(snapshotId: string): Promise<{ filename: string; stream: ReadableStream<Uint8Array> }> {
		const snap = (await this.all()).find((s) => s.id === snapshotId);
		if (!snap) throw new UserFacingError('Copie introuvable.');
		const base = snap.path.replace(/^\//, '');
		const stamp = new Date(snap.time).toISOString().slice(0, 16).replace(/[:T]/g, '-');
		const dot = base.indexOf('.');
		const filename = dot > 0 ? `${base.slice(0, dot)}-${stamp}${base.slice(dot)}` : `${base}-${stamp}`;
		return { filename, stream: this.d.gateway.dumpStream(snap.id, snap.path) };
	}

	/** Copies hors serveur de la base d'un projet (lecture). */
	async forProject(p: ProjectRow): Promise<OffsiteSnapshot[]> {
		if (!this.configured() || !(await this.d.gateway.initialized())) return [];
		const path = projectDbPath(p.slug);
		return (await this.d.gateway.snapshots()).filter((s) => s.path === path);
	}

	/**
	 * Rapatrie une copie R2 dans les sauvegardes du CT (nom « import »). Elle se restaure
	 * ensuite avec la double confirmation habituelle : rien n'est écrasé ici.
	 */
	async fetchToProject(p: ProjectRow, snapshotId: string): Promise<{ name: string; simulated: boolean }> {
		if (!p.ip) throw new UserFacingError('Le projet n’a pas encore de CT.');
		const snap = (await this.forProject(p)).find((s) => s.id === snapshotId);
		if (!snap) throw new UserFacingError('Copie introuvable.');
		const data = await this.d.gateway.dump(snap.id, snap.path, OFFSITE_MAX_DUMP_BYTES);
		const name = backupName('import', new Date(snap.time));
		const res = await this.s.shell.dbWrite({ ip: p.ip, sshHostKey: p.sshHostKey }, DbCommand.importDump(p, name), `Rapatrier la copie R2 du ${new Date(snap.time).toISOString().slice(0, 16)} → ${name}`, 15 * 60_000, data);
		if (res.code !== 0) throw new UserFacingError(`Rapatriement refusé : ${res.stderr.trim().slice(-300)}`);
		return { name, simulated: this.s.guard.isDryRun() };
	}
}

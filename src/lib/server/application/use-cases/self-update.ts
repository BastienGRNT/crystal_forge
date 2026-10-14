/**
 * « Mettre à jour Forge » : Forge télécharge l'archive de son propre dépôt (avec le jeton
 * GitHub déjà configuré) et la dépose dans le dossier d'échange, avec request.json.
 * Le build et le redémarrage sont faits HORS du conteneur, par le service systemd
 * forge-update du CT 150 (infra/08-forge-updater.sh) : Forge n'a ni le socket Docker
 * ni aucun accès à l'hôte. Le service écrit status.json, current.json et update.log.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage, UserFacingError } from '$lib/domain/errors';
import type { JobEngine } from '../jobs/engine';
import type { ForgeServices } from '../services';

export type UpdateState = 'pending' | 'running' | 'done' | 'failed';

export interface UpdateStatus {
	/** Service de mise à jour installé dans le CT 150 (dossier monté + updater.json). */
	installed: boolean;
	installHint: string | null;
	repo: string;
	branch: string;
	current: { sha: string; at: string | null } | null;
	run: { state: UpdateState; sha: string; message: string; at: string | null } | null;
	log: string[];
}

export interface UpdateCheck {
	latest: { sha: string; message: string; date: string | null };
	upToDate: boolean;
}

const INSTALL_HINT = 'Sur l’hôte Proxmox : bash infra/08-forge-updater.sh --from /root/crystal_forge (installe le service de mise à jour du CT 150 et déploie cette version).';
/** Au-delà, une demande restée « en attente » est considérée comme perdue (service arrêté ?). */
const STALE_MS = 45 * 60_000;

async function readJson<T>(path: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(path, 'utf8')) as T;
	} catch {
		return null;
	}
}

export class SelfUpdateService {
	/** Mode mock : progression simulée en mémoire, aucun fichier écrit. */
	#mock: { sha: string; startedAt: number } | null = null;
	/** Mis à jour à chaque lecture du statut ; lu de façon synchrone par le moteur de jobs. */
	#busySync = false;

	constructor(
		private readonly s: ForgeServices,
		private readonly engine: JobEngine
	) {
		engine.setBlocker(() => (this.#busySync ? 'Mise à jour de Forge en cours : les jobs reprendront après le redémarrage.' : null));
	}

	get #dir() {
		return this.s.config.updatesDir;
	}

	#repo(): { owner: string; name: string; full: string; branch: string } {
		const full = this.s.settings.get('forge.updateRepo').trim();
		const [owner, name] = full.split('/');
		if (!owner || !name || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) throw new UserFacingError(`Dépôt de Forge invalide : ${full}`);
		return { owner, name, full, branch: this.s.settings.get('forge.updateBranch').trim() || 'main' };
	}

	async status(): Promise<UpdateStatus> {
		const repo = this.#repo();
		if (this.s.config.mode === 'mock') return this.#mockStatus(repo.full, repo.branch);
		const dir = this.#dir;
		const installed = !!(await readJson(join(dir, 'updater.json')));
		const current = await readJson<{ sha: string; at?: string }>(join(dir, 'current.json'));
		const run = await readJson<{ state: UpdateState; sha: string; message?: string; at?: string }>(join(dir, 'status.json'));
		const pending = await readJson<{ sha: string; requestedAt: number }>(join(dir, 'request.json'));
		const log = (await readFile(join(dir, 'update.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).slice(-60);
		let state = run ? { state: run.state, sha: run.sha, message: run.message ?? '', at: run.at ?? null } : null;
		if (pending && (!state || state.state !== 'running')) {
			const stale = Date.now() - pending.requestedAt > STALE_MS;
			state = { state: stale ? 'failed' : 'pending', sha: pending.sha, message: stale ? 'Demande jamais prise en charge : le service forge-update.path est-il actif dans le CT 150 ?' : 'En attente du service de mise à jour…', at: new Date(pending.requestedAt).toISOString() };
		}
		this.#busySync = state?.state === 'pending' || state?.state === 'running';
		return {
			installed,
			installHint: installed ? null : INSTALL_HINT,
			repo: repo.full,
			branch: repo.branch,
			current: current ? { sha: current.sha, at: current.at ?? null } : null,
			run: state,
			log
		};
	}

	async check(): Promise<UpdateCheck> {
		const repo = this.#repo();
		const latest = await this.s.github.api.latestCommit(repo.owner, repo.name, repo.branch);
		const current = (await this.status()).current;
		return { latest, upToDate: current?.sha === latest.sha };
	}

	/** Dépose l'archive du dernier commit et la demande ; le service du CT 150 fait le reste. */
	async request(): Promise<{ sha: string }> {
		if (this.engine.isBusy()) throw new UserFacingError('Un job est en cours : attendez sa fin avant de mettre Forge à jour (le conteneur va redémarrer).');
		const st = await this.status();
		if (!st.installed) throw new UserFacingError(`Service de mise à jour absent. ${INSTALL_HINT}`);
		if (st.run && (st.run.state === 'pending' || st.run.state === 'running')) throw new UserFacingError('Une mise à jour est déjà en cours.');
		const repo = this.#repo();
		const latest = await this.s.github.api.latestCommit(repo.owner, repo.name, repo.branch);
		if (!/^[0-9a-f]{40}$/.test(latest.sha)) throw new UserFacingError(`Commit inattendu : ${latest.sha}`);

		if (this.s.config.mode === 'mock') {
			this.#mock = { sha: latest.sha, startedAt: Date.now() };
			this.#busySync = true;
			return { sha: latest.sha };
		}

		const dir = this.#dir;
		const file = `forge-${latest.sha}.tar.gz`;
		try {
			const archive = await this.s.github.api.downloadTarball(repo.owner, repo.name, latest.sha);
			if (archive.length < 1024 || archive[0] !== 0x1f || archive[1] !== 0x8b) throw new Error('archive tar.gz invalide');
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, `${file}.part`), archive, { mode: 0o640 });
			await rename(join(dir, `${file}.part`), join(dir, file));
			// Écrit en dernier, de façon atomique : c'est ce fichier qui déclenche forge-update.path.
			const req = { sha: latest.sha, file, message: latest.message.split('\n')[0] ?? '', requestedAt: Date.now() };
			await writeFile(join(dir, 'request.json.part'), JSON.stringify(req), { mode: 0o640 });
			await rename(join(dir, 'request.json.part'), join(dir, 'request.json'));
		} catch (err) {
			await rm(join(dir, `${file}.part`), { force: true }).catch(() => {});
			throw new UserFacingError(`Préparation de la mise à jour impossible : ${errorMessage(err)}`);
		}
		this.#busySync = true;
		return { sha: latest.sha };
	}

	#mockStatus(repo: string, branch: string): UpdateStatus {
		const base = { installed: true, installHint: null, repo, branch };
		const m = this.#mock;
		if (!m) return { ...base, current: { sha: '0'.repeat(40), at: null }, run: null, log: [] };
		const elapsed = Date.now() - m.startedAt;
		const steps = ['Archive vérifiée', 'Copie de l’arborescence précédente', 'docker compose build', 'docker compose up -d', 'Forge répond sur :3000'];
		const shown = Math.min(steps.length, Math.floor(elapsed / 1500) + 1);
		const done = shown === steps.length && elapsed > steps.length * 1500;
		this.#busySync = !done;
		return {
			...base,
			current: done ? { sha: m.sha, at: new Date().toISOString() } : { sha: '0'.repeat(40), at: null },
			run: { state: done ? 'done' : 'running', sha: m.sha, message: done ? 'Mise à jour simulée terminée (mode démo : rien n’est reconstruit).' : steps[shown - 1] ?? '', at: new Date(m.startedAt).toISOString() },
			log: steps.slice(0, shown).map((s) => `[démo] ${s}`)
		};
	}
}

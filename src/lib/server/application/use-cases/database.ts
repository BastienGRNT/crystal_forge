/**
 * Onglet « Base de données » : détection, informations, tables, console SQL,
 * sauvegardes (dump gzip sur le CT) et restauration.
 * Lecture seule par défaut ; toute écriture passe par le garde (DRY_RUN respecté).
 */
import { gzipSync } from 'node:zlib';
import { analyzeCompose, type DbKind, type SqlDbKind } from '$lib/domain/compose-analysis';
import { repoPath } from '$lib/domain/compose-detect';
import {
	analyzeSql,
	backupName,
	browseSql,
	infoSql,
	isValidBackupName,
	MAX_DOWNLOAD_BYTES,
	MAX_IMPORT_BYTES,
	MAX_RESULT_BYTES,
	parseBackupName,
	parseQueryOutput,
	tablesSql,
	type QueryResult
} from '$lib/domain/database';
import { errorMessage, UserFacingError } from '$lib/domain/errors';
import { parseEnv } from '$lib/domain/env-file';
import type { ProjectRow } from '$server/infrastructure/db/schema';
import { DbCommand, type DbLocation, type ShellTarget } from '../gateways';
import type { JobEngine } from '../jobs/engine';
import { dbLocation } from '../jobs/steps/database';
import { envAad, type ForgeServices } from '../services';

export interface DbTable {
	schema: string;
	name: string;
	rows: number;
	bytes: number;
}

export interface DbBackup {
	name: string;
	size: number;
	at: number;
	reason: string;
}

export interface DbQueryOutcome extends QueryResult {
	ms: number;
	simulated: boolean;
	/** Sauvegarde prise automatiquement avant une requête destructrice. */
	backup: string | null;
	message: string | null;
}

const DEFAULT_PORT: Record<SqlDbKind, number> = { postgres: 5432, mysql: 3306, mariadb: 3306 };

export class DatabaseService {
	constructor(
		private readonly s: ForgeServices,
		private readonly engine: JobEngine
	) {}

	#target(p: ProjectRow): ShellTarget {
		if (!p.ip) throw new UserFacingError('Le projet n’a pas encore de CT.');
		return { ip: p.ip, sshHostKey: p.sshHostKey };
	}

	/** Bases déclarées dans le compose du dépôt (lecture GitHub). */
	async candidates(p: ProjectRow): Promise<{ service: string; kind: DbKind }[]> {
		if (p.deployMode !== 'compose' || !p.composeFile) return [];
		const file = await this.s.github.api.getFile(p.repoOwner, p.repoName, repoPath(p.workdir, p.composeFile), p.branch);
		return file ? analyzeCompose(file.content).databases : [];
	}

	/** Choisit le service de base du projet, puis met à jour les variables FORGE_DB_*. */
	async configure(p: ProjectRow, service: string | null): Promise<number> {
		if (this.s.repos.jobs.activeForProject(p.id)) throw new UserFacingError('Un job est déjà en cours pour ce projet.');
		if (service) {
			const found = (await this.candidates(p)).find((c) => c.service === service);
			if (!found) throw new UserFacingError(`« ${service} » n'est pas une base reconnue du compose.`);
			this.s.repos.projects.update(p.id, { dbService: found.service, dbKind: found.kind });
		} else {
			this.s.repos.projects.update(p.id, { dbService: null, dbKind: null });
		}
		return this.engine.enqueue({ type: 'sync_config', projectId: p.id, params: { onlyVars: true } }).id;
	}

	#loc(p: ProjectRow): DbLocation {
		try {
			return dbLocation(p);
		} catch (err) {
			throw new UserFacingError(errorMessage(err));
		}
	}

	async #select(p: ProjectRow, sql: string): Promise<QueryResult> {
		const loc = this.#loc(p);
		const res = await this.s.shell.dbRead(this.#target(p), DbCommand.query(loc, sql, true));
		return this.#parse(loc.kind, res.stdout, res.stderr);
	}

	#parse(kind: SqlDbKind, stdout: string, stderr: string): QueryResult {
		const rc = Number(/__FORGE_RC=(\d+)/.exec(stderr)?.[1] ?? 0);
		const err = stderr.replace(/__FORGE_RC=\d+\s*/g, '').trim();
		if (rc !== 0) throw new UserFacingError(err || `Erreur du client SQL (code ${rc}).`);
		const truncated = stdout.length > MAX_RESULT_BYTES;
		let out = truncated ? stdout.slice(0, MAX_RESULT_BYTES) : stdout;
		if (truncated) out = out.slice(0, out.lastIndexOf('\n') + 1);
		return parseQueryOutput(kind, out, truncated);
	}

	async info(p: ProjectRow) {
		const loc = this.#loc(p);
		const [infoRes, inspect] = await Promise.all([
			this.#select(p, infoSql(loc.kind)),
			this.s.shell.dbRead(this.#target(p), DbCommand.inspect(loc)).catch(() => null)
		]);
		const row = infoRes.rows[0] ?? [];
		const [state, ...ips] = (inspect?.stdout.trim() ?? '').split(/\s+/);
		const env = parseEnv(p.envEncrypted ? this.s.cipher.decrypt(p.envEncrypted, envAad(p.id)) : '').entries;
		const pick = (...keys: string[]) => keys.map((k) => env.find((e) => e.key === k)?.value).find((v) => v) ?? null;
		return {
			kind: loc.kind,
			service: loc.service,
			version: row[0] ?? null,
			database: row[1] ?? null,
			user: row[2] ?? null,
			bytes: Number(row[3] ?? 0),
			state: state || null,
			containerIp: ips.find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x)) ?? null,
			port: DEFAULT_PORT[loc.kind],
			/** Nom de la variable du .env qui contient le mot de passe (jamais la valeur). */
			passwordVar:
				loc.kind === 'postgres'
					? env.some((e) => e.key === 'POSTGRES_PASSWORD') ? 'POSTGRES_PASSWORD' : null
					: (['MARIADB_ROOT_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'MARIADB_PASSWORD', 'MYSQL_PASSWORD'].find((k) => env.some((e) => e.key === k)) ?? null),
			envUser: loc.kind === 'postgres' ? pick('POSTGRES_USER') : pick('MARIADB_USER', 'MYSQL_USER')
		};
	}

	async tables(p: ProjectRow): Promise<DbTable[]> {
		const r = await this.#select(p, tablesSql(this.#loc(p).kind));
		return r.rows.map(([schema = '', name = '', rows = '0', bytes = '0']) => ({ schema, name, rows: Number(rows), bytes: Number(bytes) }));
	}

	async browse(p: ProjectRow, schema: string, table: string, page: number, pageSize = 100): Promise<QueryResult> {
		const kind = this.#loc(p).kind;
		return this.#select(p, browseSql(kind, schema, table, pageSize, Math.max(page, 0) * pageSize));
	}

	/** Console SQL. Lecture seule : exécutée directement. Écriture : garde + sauvegarde si destructrice. */
	async query(p: ProjectRow, sql: string, opts: { write: boolean; confirmDestructive: boolean }): Promise<DbQueryOutcome> {
		const loc = this.#loc(p);
		const analysis = (() => {
			try {
				return analyzeSql(sql, loc.kind, !opts.write);
			} catch (err) {
				throw new UserFacingError(errorMessage(err));
			}
		})();
		// mysql -e « …; $(cat); ROLLBACK; » : pas de point-virgule final en double.
		const text = sql.trim().replace(/;+\s*$/, '');
		const start = Date.now();

		if (!opts.write || analysis.readOnly) {
			const r = await this.#select(p, text);
			return { ...r, ms: Date.now() - start, simulated: false, backup: null, message: r.columns.length ? null : 'Requête exécutée (aucun résultat).' };
		}

		if (analysis.destructive.length && !opts.confirmDestructive) {
			throw new UserFacingError(`Opération destructrice (${analysis.destructive.join(', ')}) : confirmez pour l'exécuter. Une sauvegarde sera prise juste avant.`);
		}
		const t = this.#target(p);
		let backup: string | null = null;
		if (analysis.destructive.length) {
			backup = backupName('pre-query');
			const b = await this.s.shell.dbWrite(t, DbCommand.backup(loc, backup), `Sauvegarder la base « ${loc.service} » avant une requête destructrice → ${backup}`);
			if (b.code !== 0) throw new UserFacingError(`Sauvegarde préalable impossible, requête annulée : ${b.stderr.trim().slice(-300)}`);
		}
		const preview = text.replace(/\s+/g, ' ').slice(0, 120);
		const res = await this.s.shell.dbWrite(t, DbCommand.query(loc, text, false), `Requête SQL (écriture) sur « ${loc.service} » : ${preview}${text.length > 120 ? '…' : ''}`, 150_000);
		const simulated = this.s.guard.isDryRun();
		if (simulated) {
			return { columns: [], rows: [], truncated: false, ms: Date.now() - start, simulated, backup, message: '[DRY-RUN] Requête journalisée, non exécutée.' };
		}
		const r = this.#parse(loc.kind, res.stdout, res.stderr);
		return { ...r, ms: Date.now() - start, simulated, backup, message: r.columns.length ? null : 'Requête exécutée.' };
	}

	async backups(p: ProjectRow): Promise<DbBackup[]> {
		if (!p.ip) return [];
		const res = await this.s.shell.dbRead(this.#target(p), DbCommand.listBackups(p));
		return res.stdout
			.split('\n')
			.map((l) => l.split('\t'))
			.filter(([name]) => !!name && isValidBackupName(name))
			.map(([name = '', size = '0', mtime = '0']) => {
				const parsed = parseBackupName(name);
				return { name, size: Number(size), at: parsed?.at ?? Math.round(Number(mtime) * 1000), reason: parsed?.reason ?? 'manual' };
			})
			.sort((a, b) => b.at - a.at);
	}

	backup(p: ProjectRow): number {
		this.#loc(p);
		if (this.s.repos.jobs.activeForProject(p.id)) throw new UserFacingError('Un job est déjà en cours pour ce projet.');
		return this.engine.enqueue({ type: 'db_backup', projectId: p.id, params: { reason: 'manual' } }).id;
	}

	/** Restauration : double confirmation (nom du projet), sauvegarde de l'état actuel d'abord. */
	restore(p: ProjectRow, name: string, confirmSlug: string): number {
		this.#loc(p);
		if (!isValidBackupName(name)) throw new UserFacingError('Sauvegarde invalide.');
		if (confirmSlug.trim() !== p.slug) throw new UserFacingError(`Tapez « ${p.slug} » pour confirmer la restauration.`);
		if (this.s.repos.jobs.activeForProject(p.id)) throw new UserFacingError('Un job est déjà en cours pour ce projet.');
		return this.engine.enqueue({ type: 'db_restore', projectId: p.id, params: { restore: name } }).id;
	}

	/**
	 * Importe un dump (.sql ou .sql.gz, par ex. depuis l'ancien CT d'une app migrée) dans
	 * le dossier des sauvegardes du projet. Il apparaît ensuite dans la liste, prêt à être
	 * restauré avec la double confirmation habituelle. Rien n'est restauré ici.
	 */
	async importDump(p: ProjectRow, file: { name: string; data: Buffer }): Promise<{ name: string; size: number; simulated: boolean }> {
		this.#loc(p);
		if (file.data.length === 0) throw new UserFacingError('Fichier vide.');
		if (file.data.length > MAX_IMPORT_BYTES) throw new UserFacingError(`Fichier trop gros (${Math.round(MAX_IMPORT_BYTES / 1024 ** 2)} Mo max) : utilisez infra/06-migrate-db.sh.`);
		const gz = file.data[0] === 0x1f && file.data[1] === 0x8b;
		if (!gz && !/\.sql$/i.test(file.name)) throw new UserFacingError('Format attendu : .sql ou .sql.gz');
		const data = gz ? file.data : gzipSync(file.data);
		const name = backupName('import');
		const res = await this.s.shell.dbWrite(this.#target(p), DbCommand.importDump(p, name), `Importer « ${file.name} » (${Math.round(data.length / 1024)} Ko) → ${name}`, 10 * 60_000, data);
		if (res.code !== 0) throw new UserFacingError(`Import refusé : ${res.stderr.trim().slice(-300) || 'fichier gzip invalide'}`);
		return { name, size: data.length, simulated: this.s.guard.isDryRun() };
	}

	async download(p: ProjectRow, name: string): Promise<Buffer> {
		if (!isValidBackupName(name)) throw new UserFacingError('Sauvegarde invalide.');
		const res = await this.s.shell.dbRead(this.#target(p), DbCommand.download(p, name, MAX_DOWNLOAD_BYTES), 5 * 60_000);
		if (res.code !== 0) throw new UserFacingError(`Sauvegarde introuvable : ${res.stderr.trim()}`);
		const [sizeLine = '0', data = ''] = res.stdout.split('\n');
		if (Number(sizeLine) > MAX_DOWNLOAD_BYTES) {
			throw new UserFacingError(`Fichier trop gros pour le navigateur (${Math.round(Number(sizeLine) / 1024 ** 2)} Mo) : récupérez-le avec scp.`);
		}
		return Buffer.from(data.trim(), 'base64');
	}
}

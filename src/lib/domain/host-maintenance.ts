/**
 * Entretien de l'hôte fait par Forge lui-même (règle : le moins de manuel possible).
 *   • Jobs de sauvegarde vzdump : CT critiques (NPM, Forge) et tout le pool des projets.
 *   • CT critiques (NPM, Forge) : plancher de RAM et priorité CPU.
 *   • CT de projet : priorité CPU selon l'environnement (la prod passe avant le dev).
 * Fonctions pures : le plan, et les garde-fous appliqués AVANT chaque écriture.
 *
 * Droits Proxmox (vérifiés dans pve-manager, PVE/API2/Backup.pm) :
 *   POST/PUT /cluster/backup : Sys.Modify sur « / », Datastore.Allocate sur le stockage
 *   cible, VM.Backup sur /pool/<pool> si le job sélectionne un pool. tmpdir, dumpdir,
 *   script et job-id restent réservés à root@pam.
 */
import { SafetyViolation } from './errors';

/** Stockage dédié aux sauvegardes de Forge (créé par bootstrap.sh) : Forge n'a pas Datastore.Allocate ailleurs. */
export const FORGE_BACKUP_STORAGE = 'forge-backups';
export const BACKUP_RETENTION = 'keep-daily=7,keep-weekly=4';
export const BACKUP_JOB_CRITICAL = 'forge-prod-daily';
export const BACKUP_JOB_PROJECTS = 'forge-projects-daily';

/** Poids CPU (cgroup v2, défaut Proxmox 100) : sous charge, NPM et Forge d'abord, le dev en dernier. */
export const CPU_WEIGHTS = { critical: 400, production: 200, development: 50 } as const;
/** RAM minimale d'un CT critique (NPM touchait sa limite de 512 Mo, audit du 2026-11-16). */
export const CRITICAL_MIN_MEMORY_MB = 1024;
/** Forge n'augmente jamais un CT critique au-delà. */
export const CRITICAL_MAX_MEMORY_MB = 4096;
/** RAM disponible à garder sur l'hôte après une augmentation. */
export const HOST_RAM_RESERVE_MB = 2048;

export interface DesiredBackupJob {
	id: string;
	schedule: string;
	vmid?: string;
	pool?: string;
	storage: string;
	mode: 'snapshot';
	compress: 'zstd';
	'prune-backups': string;
	enabled: 1;
	comment: string;
}

export function desiredBackupJobs(o: { criticalCtids: number[]; pool: string }): DesiredBackupJob[] {
	const common = { storage: FORGE_BACKUP_STORAGE, mode: 'snapshot', compress: 'zstd', 'prune-backups': BACKUP_RETENTION, enabled: 1 } as const;
	const jobs: DesiredBackupJob[] = [];
	const critical = [...new Set(o.criticalCtids)].sort((a, b) => a - b);
	if (critical.length) jobs.push({ ...common, id: BACKUP_JOB_CRITICAL, schedule: '03:30', vmid: critical.join(','), comment: 'Géré par Forge : NPM et Forge' });
	jobs.push({ ...common, id: BACKUP_JOB_PROJECTS, schedule: '04:00', pool: o.pool, comment: 'Géré par Forge : tous les CT de projet, présents et futurs' });
	return jobs;
}

export interface CurrentBackupJob {
	id: string;
	enabled: boolean;
	schedule: string;
	vmid: string | null;
	pool: string | null;
	storage: string | null;
}

const sameIds = (a: string | null | undefined, b: string | null | undefined) =>
	(a ?? '').split(',').filter(Boolean).map(Number).sort((x, y) => x - y).join(',') === (b ?? '').split(',').filter(Boolean).map(Number).sort((x, y) => x - y).join(',');

/** Ce qu'il faut créer ou mettre à jour pour atteindre l'état voulu (jamais de suppression). */
export function backupJobChanges(current: CurrentBackupJob[], desired: DesiredBackupJob[]): { job: DesiredBackupJob; exists: boolean }[] {
	return desired.flatMap((job): { job: DesiredBackupJob; exists: boolean }[] => {
		const cur = current.find((c) => c.id === job.id);
		if (!cur) return [{ job, exists: false }];
		const same = cur.enabled && cur.schedule === job.schedule && cur.storage === job.storage && sameIds(cur.vmid, job.vmid) && (cur.pool ?? undefined) === job.pool;
		return same ? [] : [{ job, exists: true }];
	});
}

const BACKUP_JOB_KEYS = new Set(['id', 'schedule', 'vmid', 'pool', 'storage', 'mode', 'compress', 'prune-backups', 'enabled', 'comment', 'delete']);

/** Garde-fou d'un job de sauvegarde écrit par Forge. */
export function assertSafeBackupJob(job: Record<string, unknown>, ctx: { pool: string; criticalCtids: number[] }): void {
	for (const k of Object.keys(job)) {
		if (!BACKUP_JOB_KEYS.has(k)) throw new SafetyViolation('backup.key', `Option de sauvegarde interdite : ${k}`);
	}
	if (typeof job.id !== 'string' || !/^forge-[a-z-]+$/.test(job.id)) throw new SafetyViolation('backup.id', 'Forge ne gère que ses propres jobs (préfixe « forge- »).');
	if (job.storage !== FORGE_BACKUP_STORAGE) throw new SafetyViolation('backup.storage', `Les sauvegardes de Forge vont uniquement sur « ${FORGE_BACKUP_STORAGE} ».`);
	if (job.pool !== undefined && job.pool !== ctx.pool) throw new SafetyViolation('backup.pool', `Pool « ${String(job.pool)} » refusé (seul « ${ctx.pool} » est autorisé).`);
	if (job.vmid !== undefined) {
		const ids = String(job.vmid).split(',').map(Number);
		if (ids.some((id) => !ctx.criticalCtids.includes(id))) throw new SafetyViolation('backup.vmid', 'Un job par VMID ne peut viser que les CT critiques (NPM, Forge).');
	}
	if (job.pool !== undefined && job.vmid !== undefined) throw new SafetyViolation('backup.selection', 'Un job sélectionne soit un pool, soit des VMID.');
}

/**
 * Garde-fou des réglages d'un CT critique (hors pool) : seulement la RAM (jamais à la baisse,
 * plafonnée) et le poids CPU. Le jeton n'a d'ailleurs que VM.Config.Memory et VM.Config.CPU sur ces CT.
 */
export function assertSafeCriticalCtTune(o: { vmid: number; criticalCtids: number[]; config: Record<string, unknown>; currentMemoryMb: number }): void {
	if (!o.criticalCtids.includes(o.vmid)) throw new SafetyViolation('tune.ct', `Le CT ${o.vmid} n'est pas un CT critique géré par Forge.`);
	for (const [k, v] of Object.entries(o.config)) {
		if (k === 'memory') {
			const mb = Number(v);
			if (!Number.isInteger(mb) || mb < o.currentMemoryMb) throw new SafetyViolation('tune.memory', `RAM du CT ${o.vmid} : Forge ne la réduit jamais.`);
			if (mb > CRITICAL_MAX_MEMORY_MB) throw new SafetyViolation('tune.memory', `RAM du CT ${o.vmid} plafonnée à ${CRITICAL_MAX_MEMORY_MB} Mo.`);
		} else if (k === 'cpuunits') {
			const w = Number(v);
			if (!Number.isInteger(w) || w < 1 || w > 10000) throw new SafetyViolation('tune.cpu', 'Poids CPU entre 1 et 10000.');
		} else {
			throw new SafetyViolation('tune.key', `Réglage interdit sur un CT critique : ${k}`);
		}
	}
}

/**
 * Réglage voulu d'un CT critique : poids CPU haut, et RAM portée au plancher s'il l'utilise
 * à 80 % ou plus (il étouffe) et que l'hôte garde sa réserve.
 */
export function criticalCtPlan(o: { memoryMb: number; usedMb: number; cpuunits: number | null; hostAvailableMb: number }): Record<string, number> {
	const out: Record<string, number> = {};
	const tight = o.usedMb >= o.memoryMb * 0.8;
	if (tight && o.memoryMb < CRITICAL_MIN_MEMORY_MB && o.hostAvailableMb - (CRITICAL_MIN_MEMORY_MB - o.memoryMb) >= HOST_RAM_RESERVE_MB) out.memory = CRITICAL_MIN_MEMORY_MB;
	if (o.cpuunits !== CPU_WEIGHTS.critical) out.cpuunits = CPU_WEIGHTS.critical;
	return out;
}

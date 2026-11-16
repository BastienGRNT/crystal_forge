/**
 * Sauvegardes hors serveur (Cloudflare R2, API S3) avec restic : chiffrées côté Forge
 * avant l'envoi, dédupliquées. Règles pures : configuration acceptée, chemins des
 * fichiers sauvegardés, politique de rétention, lecture des instantanés.
 */
import { SafetyViolation } from './errors';

/** Rétention : 7 jours, 4 semaines, 6 mois (par fichier sauvegardé). */
export const OFFSITE_RETENTION = { daily: 7, weekly: 4, monthly: 6 } as const;
/** Une sauvegarde complète par jour ; la base de Forge toutes les heures. */
export const OFFSITE_PROJECTS_EVERY_MS = 23 * 3600_000;
export const OFFSITE_FORGE_EVERY_MS = 3600_000;
/** Test de restauration automatique : tous les 30 jours. */
export const OFFSITE_RESTORE_TEST_EVERY_MS = 30 * 24 * 3600_000;
/** Taille max d'un dump rapatrié en mémoire. */
export const OFFSITE_MAX_DUMP_BYTES = 500 * 1024 * 1024;

/** Fichiers du dépôt (restic --stdin : un fichier à la racine par source). */
export const FORGE_DB_PATH = '/forge.db';
export const projectDbPath = (slug: string) => {
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) throw new SafetyViolation('offsite.slug', `Projet invalide : ${slug}`);
	return `/project-${slug}.sql.gz`;
};

export interface OffsiteConfig {
	/** https://<compte>.r2.cloudflarestorage.com (ou tout point S3 en https). */
	endpoint: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** Mot de passe du dépôt restic (dérivé de la clé maître de Forge). */
	password: string;
}

/** Vérifie la configuration ; renvoie l'URL de dépôt restic (s3:https://hôte/bucket/forge). */
export function resticRepository(c: Pick<OffsiteConfig, 'endpoint' | 'bucket'>): string {
	let url: URL;
	try {
		url = new URL(c.endpoint.trim());
	} catch {
		throw new SafetyViolation('offsite.endpoint', `Adresse R2 invalide : ${c.endpoint}`);
	}
	if (url.protocol !== 'https:' || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search) {
		throw new SafetyViolation('offsite.endpoint', 'Adresse R2 attendue : https://<compte>.r2.cloudflarestorage.com (sans chemin).');
	}
	// Règles de nommage S3 : 3–63 caractères, minuscules, chiffres, tirets.
	if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(c.bucket.trim())) throw new SafetyViolation('offsite.bucket', `Nom de bucket invalide : ${c.bucket}`);
	return `s3:https://${url.host}/${c.bucket.trim()}/forge`;
}

export function isOffsiteConfigured(c: Partial<OffsiteConfig>): c is OffsiteConfig {
	return !!(c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey && c.password);
}

/** Arguments restic de la rétention (forget --prune), groupés par fichier sauvegardé. */
export function retentionArgs(): string[] {
	return ['--group-by', 'paths', '--keep-daily', String(OFFSITE_RETENTION.daily), '--keep-weekly', String(OFFSITE_RETENTION.weekly), '--keep-monthly', String(OFFSITE_RETENTION.monthly), '--prune'];
}

export interface OffsiteSnapshot {
	id: string;
	time: number;
	path: string;
	tags: string[];
	size: number | null;
}

/** Lit la sortie `restic snapshots --json`. */
export function parseSnapshots(json: string): OffsiteSnapshot[] {
	const raw: unknown = JSON.parse(json || '[]');
	if (!Array.isArray(raw)) return [];
	return raw
		.map((s: Record<string, unknown>) => ({
			id: String(s.short_id ?? s.id ?? '').slice(0, 64),
			time: Date.parse(String(s.time ?? '')),
			path: Array.isArray(s.paths) ? String(s.paths[0] ?? '').replace(/^(?!\/)/, '/') : '',
			tags: Array.isArray(s.tags) ? s.tags.map(String) : [],
			size: typeof (s.summary as Record<string, unknown> | undefined)?.total_bytes_processed === 'number' ? ((s.summary as Record<string, number>).total_bytes_processed ?? null) : null
		}))
		.filter((s) => /^[0-9a-f]{8,64}$/.test(s.id) && Number.isFinite(s.time))
		.sort((a, b) => b.time - a.time);
}

export function assertSnapshotId(id: string): void {
	if (!/^[0-9a-f]{8,64}$/.test(id)) throw new SafetyViolation('offsite.snapshot', `Instantané invalide : ${id}`);
}

/** Seuls ces fichiers peuvent être écrits dans le dépôt. */
export function assertOffsitePath(path: string): void {
	if (path === FORGE_DB_PATH) return;
	if (!/^\/project-[a-z0-9][a-z0-9-]{0,62}\.sql\.gz$/.test(path)) throw new SafetyViolation('offsite.path', `Chemin de sauvegarde refusé : ${path}`);
}

/**
 * Cache de build Docker des CT de projet : chaque `docker compose build` y empile des
 * couches qui ne sont jamais nettoyées (audit du 2026-11-16 : 31 Go, dont 10 Go dans un
 * seul CT). Il remplit le disque, gonfle dockerd en RAM et est recopié par la sauvegarde.
 * Le nettoyer ne touche ni aux conteneurs, ni aux images en service, ni aux volumes.
 */

/** Au-delà, Forge nettoie automatiquement le cache d'un CT. */
export const BUILD_CACHE_AUTO_PRUNE_BYTES = 2 * 1024 ** 3;
/** Cache gardé après un nettoyage automatique (les builds suivants restent rapides). */
export const BUILD_CACHE_KEEP = '2gb';

const UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };

/** « 10.2GB », « 512MB », « 0B », « 1.5kB » (format de `docker system df`) → octets. */
export function parseDockerSize(raw: string): number {
	const m = /^\s*([\d.]+)\s*([a-z]+)\s*$/i.exec(raw);
	if (!m) return 0;
	const unit = UNITS[m[2]!.toLowerCase()];
	return unit ? Math.round(Number(m[1]) * unit) : 0;
}

export interface BuildCacheUsage {
	buildCacheBytes: number;
	imagesBytes: number;
	diskUsedBytes: number | null;
	diskTotalBytes: number | null;
}

/**
 * Sortie de ReadCommand.buildCache() :
 *   lignes « Type<TAB>Taille » de `docker system df`, puis « used size » de `df -B1 /`.
 */
export function parseBuildCacheUsage(stdout: string): BuildCacheUsage {
	const out: BuildCacheUsage = { buildCacheBytes: 0, imagesBytes: 0, diskUsedBytes: null, diskTotalBytes: null };
	for (const line of stdout.split('\n')) {
		const [type, size] = line.split('\t');
		if (size === undefined) {
			const df = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
			if (df) {
				out.diskUsedBytes = Number(df[1]);
				out.diskTotalBytes = Number(df[2]);
			}
			continue;
		}
		if (type === 'Build Cache') out.buildCacheBytes = parseDockerSize(size);
		else if (type === 'Images') out.imagesBytes = parseDockerSize(size);
	}
	return out;
}

/**
 * Commande de nettoyage. « all » vide tout le cache ; sinon on garde BUILD_CACHE_KEEP
 * (les couches les plus récentes). `--keep-storage` est déprécié dans les Docker récents
 * (au profit de `--reserved-space`) : repli sur un filtre d'âge s'il est refusé.
 */
export function pruneBuildCacheCommand(all: boolean): string {
	const prune = all
		? 'docker builder prune -a -f'
		: `{ docker builder prune -a -f --keep-storage ${BUILD_CACHE_KEEP} 2>/dev/null || docker builder prune -a -f --filter until=168h; }`;
	return `: forge-op=prunecache; ${prune} | tail -n 1; df -h / | tail -n 1`;
}

export function formatBytes(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} Go`;
	return `${Math.round(bytes / 1024 ** 2)} Mo`;
}

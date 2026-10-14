/**
 * Détection du mode de déploiement d'un dépôt, par ordre de priorité :
 * docker-compose.prod.yml > docker-compose.yml > compose.yaml > Dockerfile seul.
 */

export type DeployMode = 'compose' | 'dockerfile';

export interface DetectionResult {
	supported: boolean;
	mode: DeployMode | null;
	file: string | null;
	/** Fichiers trouvés (pour l'UI). */
	found: string[];
	reason: string;
}

export const COMPOSE_PRIORITY = [
	'docker-compose.prod.yml',
	'docker-compose.prod.yaml',
	'docker-compose.yml',
	'docker-compose.yaml',
	'compose.yaml',
	'compose.yml'
] as const;

export function detectDeployMode(fileNames: string[]): DetectionResult {
	const names = new Set(fileNames);
	const found = [...COMPOSE_PRIORITY, 'Dockerfile'].filter((f) => names.has(f));
	for (const candidate of COMPOSE_PRIORITY) {
		if (names.has(candidate)) {
			return { supported: true, mode: 'compose', file: candidate, found, reason: `Docker Compose (${candidate})` };
		}
	}
	if (names.has('Dockerfile')) {
		return { supported: true, mode: 'dockerfile', file: 'Dockerfile', found, reason: 'Dockerfile seul' };
	}
	const nodeHint = names.has('package.json') ? ' (projet Node natif détecté)' : '';
	return {
		supported: false,
		mode: null,
		file: null,
		found,
		reason: `Aucun docker-compose ni Dockerfile${nodeHint} : non supporté en v1`
	};
}

/** Normalise un sous-dossier de travail : « ./app/ » → « app », « . » ou « » → « . ». */
export function normalizeWorkdir(input: string | null | undefined): string {
	const s = (input ?? '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
	if (s === '' || s === '.') return '.';
	if (s.split('/').some((part) => part === '..' || part === '')) {
		throw new Error(`Sous-dossier invalide : ${input}`);
	}
	if (!/^[A-Za-z0-9._/-]+$/.test(s)) throw new Error(`Sous-dossier invalide : ${input}`);
	return s;
}

/** Chemin d'un fichier du dépôt relatif au sous-dossier de travail. */
export function repoPath(workdir: string, file: string): string {
	return workdir === '.' ? file : `${workdir}/${file}`;
}

/** Valide un nom de service compose (utilisé dans `docker compose exec -T <service>`). */
export function isValidServiceName(name: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(name);
}

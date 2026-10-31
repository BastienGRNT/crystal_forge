/**
 * Droits d'accès : qui peut ouvrir quelle page ou lancer quelle action.
 * Règle pure, appliquée côté serveur par hooks.server.ts à CHAQUE requête
 * (masquer un bouton dans l'interface ne protège rien).
 */

export type Role = 'admin' | 'collaborator';
/** read < deploy < edit. L'admin a tout, y compris ce qui n'est accordé à personne d'autre. */
export type AccessLevel = 'read' | 'deploy' | 'edit';

export const ACCESS_LEVELS: AccessLevel[] = ['read', 'deploy', 'edit'];

export const ACCESS_LABELS: Record<AccessLevel, string> = {
	read: 'Lecture',
	deploy: 'Déploiement',
	edit: 'Édition'
};

const RANK: Record<AccessLevel, number> = { read: 1, deploy: 2, edit: 3 };

export function levelAtLeast(have: AccessLevel | null | undefined, need: AccessLevel): boolean {
	return !!have && RANK[have] >= RANK[need];
}

export function isAccessLevel(value: unknown): value is AccessLevel {
	return typeof value === 'string' && value in RANK;
}

/** Ce qu'une requête exige de l'utilisateur connecté. */
export type Requirement =
	| { kind: 'any' }
	| { kind: 'admin' }
	| { kind: 'project'; slug: string; level: AccessLevel }
	| { kind: 'job'; id: number; level: AccessLevel };

const ANY: Requirement = { kind: 'any' };
const ADMIN: Requirement = { kind: 'admin' };

/** Pages accessibles à tout utilisateur connecté (les listes sont filtrées côté serveur). */
const OPEN_PAGES = new Set(['/projects', '/jobs', '/logout', '/account']);

/** Niveau exigé par un onglet de projet, pour les actions de formulaire (nom après « ?/ »). */
const TAB_ACTIONS: Record<string, Record<string, AccessLevel | 'admin'>> = {
	deployments: { redeploy: 'deploy' },
	variables: { reveal: 'edit', save: 'edit' },
	domains: { add: 'edit', repair: 'edit', remove: 'edit' },
	database: { configure: 'edit', query: 'edit', backup: 'edit', import: 'edit', restore: 'edit' },
	container: { power: 'edit', resize: 'admin', firewall: 'admin' },
	settings: { update: 'admin', upgrade: 'admin', delete: 'admin', protection: 'admin' }
};

/** Niveau exigé pour AFFICHER un onglet de projet (« read » par défaut). */
const TAB_PAGE: Record<string, AccessLevel | 'admin'> = {
	variables: 'edit',
	database: 'edit',
	settings: 'admin'
};

function projectRequirement(slug: string, level: AccessLevel | 'admin'): Requirement {
	return level === 'admin' ? ADMIN : { kind: 'project', slug, level };
}

/** Normalise le chemin : sans la requête de données de SvelteKit ni barre finale. */
export function normalizePath(pathname: string): string {
	const p = pathname.replace(/\/__data\.json$/, '').replace(/\/+$/, '');
	return p === '' ? '/' : p;
}

/** Nom de l'action de formulaire (« ?/save » → « save », « ?/ » ou absente → « »). */
export function formActionName(search: string): string {
	for (const key of new URLSearchParams(search).keys()) {
		if (key.startsWith('/')) return key.slice(1);
	}
	return '';
}

/**
 * Exigence d'une requête. Tout ce qui n'est pas listé ici est réservé à l'admin :
 * une nouvelle page est donc fermée aux collaborateurs tant qu'on ne l'ouvre pas.
 */
export function requirementFor(method: string, pathname: string, search = ''): Requirement {
	const path = normalizePath(pathname);
	const isRead = method === 'GET' || method === 'HEAD';
	const action = formActionName(search);

	if (OPEN_PAGES.has(path)) return ANY;

	const project = /^\/projects\/([^/]+)(?:\/([^/]+))?$/.exec(path);
	if (project && project[1] !== 'new') {
		const slug = decodeURIComponent(project[1] as string);
		const tab = project[2] ?? '';
		if (isRead) return projectRequirement(slug, TAB_PAGE[tab] ?? 'read');
		const need = TAB_ACTIONS[tab]?.[action];
		return projectRequirement(slug, need ?? 'admin');
	}

	const projectApi = /^\/api\/projects\/([^/]+)\/(logs|runs|db)(?:\/.*)?$/.exec(path);
	if (projectApi) {
		const slug = decodeURIComponent(projectApi[1] as string);
		return projectRequirement(slug, projectApi[2] === 'db' ? 'edit' : 'read');
	}

	const job = /^\/jobs\/(\d+)$/.exec(path);
	if (job) {
		const id = Number(job[1]);
		// Reprendre, interrompre, annuler (rollback) et confirmer une étape : comme un déploiement.
		return { kind: 'job', id, level: isRead ? 'read' : 'deploy' };
	}
	const jobEvents = /^\/api\/jobs\/(\d+)\/events$/.exec(path);
	if (jobEvents) return { kind: 'job', id: Number(jobEvents[1]), level: 'read' };

	return ADMIN;
}

/** Nom d'utilisateur : lettres, chiffres, point, tiret, souligné (3 à 32). */
export function isValidUsername(name: string): boolean {
	return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(name);
}

export function normalizeUsername(name: string): string {
	return name.trim().toLowerCase();
}

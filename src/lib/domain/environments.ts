/**
 * Un dépôt peut avoir un serveur de production (branche main) et un serveur de développement
 * (une autre branche). Chacun est un projet Forge à part entière (son CT, son runner, son .env).
 */
export type Environment = 'production' | 'development';

export const PROD_BRANCH = 'main';
export const DEV_SLUG_SUFFIX = '-dev';
/** Branches qui ne peuvent jamais servir au développement : elles déploieraient la production. */
const PROTECTED_BRANCHES = new Set(['main', 'master']);

export const ENVIRONMENT_LABELS: Record<Environment, string> = { production: 'Production', development: 'Développement' };

export function isDevSlug(slug: string): boolean {
	return slug.endsWith(DEV_SLUG_SUFFIX);
}

export function devSlugFor(slug: string): string {
	return isDevSlug(slug) ? slug : `${slug}${DEV_SLUG_SUFFIX}`;
}

/** Le workflow du serveur de dev est un fichier à part : celui de la production n'est jamais touché. */
export function workflowFileFor(environment: Environment): string {
	return environment === 'development' ? 'forge-deploy-dev.yml' : 'forge-deploy.yml';
}

export function workflowPathFor(environment: Environment): string {
	return `.github/workflows/${workflowFileFor(environment)}`;
}

/** Environnement GitHub (secrets et variables propres au dev) ; undefined = niveau dépôt, comme la production. */
export function githubEnvironmentFor(environment: Environment): string | undefined {
	return environment === 'development' ? 'development' : undefined;
}

export interface EnvironmentSubject {
	slug: string;
	repo: string;
	branch: string;
	environment: Environment;
}

/**
 * Règles d'un nouveau serveur. `others` : les projets existants (hors supprimés).
 * Renvoie les erreurs à afficher (vide = autorisé).
 */
export function validateEnvironment(subject: EnvironmentSubject, others: EnvironmentSubject[]): string[] {
	const errors: string[] = [];
	const repo = subject.repo.toLowerCase();
	const branch = subject.branch.trim();
	if (subject.environment === 'production') {
		if (branch !== PROD_BRANCH) errors.push(`La production se déploie toujours depuis « ${PROD_BRANCH} ».`);
		if (isDevSlug(subject.slug)) errors.push(`Un identifiant se terminant par « ${DEV_SLUG_SUFFIX} » est réservé au développement.`);
	} else {
		if (!branch) errors.push('Choisissez la branche de développement.');
		else if (PROTECTED_BRANCHES.has(branch.toLowerCase())) errors.push(`La branche « ${branch} » est celle de la production : choisissez une branche de développement (dev, develop…).`);
		if (!isDevSlug(subject.slug)) errors.push(`L'identifiant d'un serveur de développement doit se terminer par « ${DEV_SLUG_SUFFIX} ».`);
	}
	for (const o of others) {
		if (o.repo.toLowerCase() !== repo) continue;
		if (o.environment === subject.environment) errors.push(`Ce dépôt a déjà un serveur de ${ENVIRONMENT_LABELS[subject.environment].toLowerCase()} (« ${o.slug} »).`);
		else if (o.branch === branch) errors.push(`La branche « ${branch} » est déjà déployée par « ${o.slug} ».`);
	}
	return errors;
}

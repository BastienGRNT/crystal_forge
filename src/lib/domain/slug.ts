/**
 * Slug d'un projet : sert de hostname du CT, de nom et de label du runner,
 * et de groupe de concurrence du workflow. Doit être un label DNS valide.
 */
export const SLUG_MAX_LENGTH = 40;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function slugify(input: string): string {
	return input
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, SLUG_MAX_LENGTH)
		.replace(/-+$/g, '');
}

export function isValidSlug(slug: string): boolean {
	return SLUG_RE.test(slug) && !slug.includes('--');
}

/** Slugs interdits : noms des CT existants ou mots réservés. */
export const RESERVED_SLUGS = new Set([
	'forge',
	'tpl-docker-runner',
	'ct100',
	'modele-dotnet-runner',
	'pharmagaia',
	'crystalwallet',
	'crystalmiaou',
	'crystalbourse',
	'localhost',
	'self-hosted'
]);

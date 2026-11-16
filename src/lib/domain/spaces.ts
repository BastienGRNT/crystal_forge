/** Espaces et étiquettes : règles pures (validation, normalisation). */

export const SPACE_COLORS = ['blue', 'violet', 'pink', 'red', 'orange', 'amber', 'green', 'teal', 'cyan', 'slate'] as const;
export type SpaceColor = (typeof SPACE_COLORS)[number];

/** Icônes proposées (noms lucide). */
export const SPACE_ICONS = ['folder', 'house', 'user', 'briefcase', 'building', 'heart', 'star', 'rocket', 'flask', 'gamepad', 'graduation', 'store'] as const;
export type SpaceIcon = (typeof SPACE_ICONS)[number];

export const MAX_TAGS = 8;
const TAG_RE = /^[a-z0-9][a-z0-9._-]{0,23}$/;

export const isSpaceColor = (v: string): v is SpaceColor => (SPACE_COLORS as readonly string[]).includes(v);
export const isSpaceIcon = (v: string): v is SpaceIcon => (SPACE_ICONS as readonly string[]).includes(v);

export function validateSpaceName(raw: string): string {
	const name = raw.trim().replace(/\s+/g, ' ');
	if (!name || name.length > 32) throw new Error("Nom d'espace : 1 à 32 caractères.");
	return name;
}

/** Une étiquette : minuscules, sans accents, espaces → tirets ; null si invalide. */
export function normalizeTag(raw: string): string | null {
	const t = raw
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.trim()
		.replace(/^#/, '')
		.replace(/\s+/g, '-');
	return TAG_RE.test(t) ? t : null;
}

/** Liste d'étiquettes depuis une saisie libre (« a, b c ») : dédoublonnée, triée, limitée. */
export function parseTagInput(raw: string): string[] {
	const out = new Set<string>();
	for (const part of raw.split(/[,\s]+/)) {
		const t = normalizeTag(part);
		if (t) out.add(t);
	}
	if (out.size > MAX_TAGS) throw new Error(`${MAX_TAGS} étiquettes au maximum.`);
	return [...out].sort();
}

/** Lecture tolérante de la colonne JSON. */
export function readTags(json: string | null | undefined): string[] {
	try {
		const v = JSON.parse(json ?? '[]');
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
	} catch {
		return [];
	}
}

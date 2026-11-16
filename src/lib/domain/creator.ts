/**
 * Projets créés par un collaborateur (P6) : ce que l'admin lui accorde, et la vérification
 * faite à CHAQUE création, côté serveur (les écrans ne font que l'afficher).
 */
export interface CreatorLimits {
	canCreate: boolean;
	maxProjects: number;
	maxRamMb: number;
	allowedZones: string[];
	githubLogin: string | null;
}

/** « a.fr, B.com ,» → ['a.fr', 'b.com'] (zones valides seulement). */
export function parseZones(text: string): string[] {
	return [...new Set(text.split(/[\s,;]+/).map((z) => z.trim().toLowerCase().replace(/\.$/, '')).filter((z) => /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(z)))];
}

/** Une zone est permise si elle est autorisée telle quelle, ou en est un sous-domaine. */
export function zoneAllowed(zone: string, allowed: string[]): boolean {
	const z = zone.trim().toLowerCase().replace(/\.$/, '');
	return allowed.some((a) => z === a || z.endsWith(`.${a}`));
}

/** Nom de compte GitHub (1 à 39 caractères, tirets non doublés, pas en bord). */
export function isGithubLogin(login: string): boolean {
	return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(login);
}

/** Erreurs qui empêchent la création (liste vide : création permise). */
export function creatorQuotaErrors(
	limits: CreatorLimits,
	owned: { memoryMb: number }[],
	request: { memoryMb: number; zones: string[] }
): string[] {
	if (!limits.canCreate) return ['Votre compte ne permet pas de créer des projets : demandez-le à un administrateur.'];
	const errors: string[] = [];
	if (owned.length >= limits.maxProjects) errors.push(`Quota atteint : ${owned.length} projet(s) sur ${limits.maxProjects} autorisé(s).`);
	const used = owned.reduce((a, p) => a + p.memoryMb, 0);
	if (used + request.memoryMb > limits.maxRamMb) {
		errors.push(`Quota de RAM dépassé : ${used} Mo utilisés + ${request.memoryMb} Mo demandés > ${limits.maxRamMb} Mo autorisés. Choisissez une taille plus petite.`);
	}
	for (const z of request.zones) {
		if (!zoneAllowed(z, limits.allowedZones)) errors.push(`Zone « ${z} » non autorisée pour votre compte${limits.allowedZones.length ? ` (autorisées : ${limits.allowedZones.join(', ')})` : ''}.`);
	}
	if (!limits.githubLogin) errors.push('Aucun compte GitHub associé à votre compte Forge : demandez-le à un administrateur.');
	return errors;
}

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function isValidZone(zone: string): boolean {
	const parts = zone.toLowerCase().split('.');
	return parts.length >= 2 && parts.every((p) => LABEL_RE.test(p)) && zone.length <= 253;
}

/** Sous-domaine : vide (domaine racine) ou un ou plusieurs labels (« api », « api.v2 »). */
export function isValidSubdomain(sub: string): boolean {
	if (sub === '') return true;
	return sub
		.toLowerCase()
		.split('.')
		.every((p) => LABEL_RE.test(p));
}

export function normalizeSubdomain(sub: string): string {
	return sub.trim().toLowerCase().replace(/\.+$/, '').replace(/^\.+/, '');
}

export function buildFqdn(subdomain: string, zone: string): string {
	const sub = normalizeSubdomain(subdomain);
	return (sub ? `${sub}.${zone}` : zone).toLowerCase();
}

/** Découpe un FQDN selon la zone la plus longue qui le contient. */
export function splitFqdn(fqdn: string, zones: string[]): { subdomain: string; zone: string } | null {
	const name = fqdn.toLowerCase().replace(/\.$/, '');
	const sorted = [...zones].sort((a, b) => b.length - a.length);
	for (const zone of sorted) {
		const z = zone.toLowerCase();
		if (name === z) return { subdomain: '', zone: z };
		if (name.endsWith(`.${z}`)) return { subdomain: name.slice(0, -(z.length + 1)), zone: z };
	}
	return null;
}

export function isValidFqdn(fqdn: string): boolean {
	return isValidZone(fqdn);
}

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

/** Un proxy host sert-il ce nom ? (les noms DNS ne tiennent pas compte de la casse) */
export function servesDomain(domainNames: string[], fqdn: string): boolean {
	const name = fqdn.toLowerCase();
	return domainNames.some((d) => d.toLowerCase() === name);
}

export function buildFqdn(subdomain: string, zone: string): string {
	const sub = normalizeSubdomain(subdomain);
	return (sub ? `${sub}.${zone}` : zone).toLowerCase();
}

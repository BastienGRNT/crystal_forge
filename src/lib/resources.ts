export const RESOURCE_LABEL: Record<string, string> = {
	pve_ct: 'Conteneur LXC',
	ovh_record: 'Enregistrement DNS',
	npm_proxy_host: 'Proxy host NPM',
	npm_certificate: 'Certificat SSL',
	gh_runner: 'Runner GitHub',
	gh_secret: 'Secret GitHub',
	gh_variable: 'Variable GitHub',
	gh_workflow: 'Fichier workflow'
};

/** Libellé court d'une ressource externe (sans le préfixe « owner/repo: »). */
export function resourceDisplay(r: { type: string; externalId: string; meta: Record<string, unknown> }): string {
	if (typeof r.meta.fqdn === 'string') return r.meta.fqdn;
	const rest = r.externalId.includes(':') ? r.externalId.slice(r.externalId.indexOf(':') + 1) : r.externalId;
	switch (r.type) {
		case 'pve_ct':
			return `CT ${r.externalId}`;
		case 'gh_runner':
			return `${(r.meta.name as string) ?? 'runner'} (#${rest})`;
		case 'gh_workflow':
			return rest.split('/').pop() ?? rest;
		default:
			return rest;
	}
}

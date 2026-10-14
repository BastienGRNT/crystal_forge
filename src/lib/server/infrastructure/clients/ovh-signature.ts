import { createHash } from 'node:crypto';

/**
 * Signature OVH API v1 :
 *   "$1$" + SHA1_HEX(AS + "+" + CK + "+" + METHOD + "+" + URL_COMPLETE + "+" + BODY + "+" + TIMESTAMP)
 * https://help.ovhcloud.com/csm/fr-api-getting-started-ovhcloud-api
 */
export function ovhSignature(input: {
	appSecret: string;
	consumerKey: string;
	method: string;
	url: string;
	body: string;
	timestamp: number;
}): string {
	const payload = [input.appSecret, input.consumerKey, input.method.toUpperCase(), input.url, input.body, String(input.timestamp)].join('+');
	return '$1$' + createHash('sha1').update(payload, 'utf8').digest('hex');
}

export interface OvhRule {
	method: string;
	path: string;
}

/** Règles d'accès d'un jeton OVH jugées dangereuses pour Forge (trop larges). */
export function dangerousOvhRules(rules: OvhRule[]): { rule: OvhRule; reason: string }[] {
	const out: { rule: OvhRule; reason: string }[] = [];
	for (const rule of rules) {
		const p = rule.path;
		if (p === '/*' || p === '*') out.push({ rule, reason: 'accès à TOUTE l’API OVH' });
		else if (rule.method !== 'GET' && (p === '/domain/zone/*' || p === '/domain/*' || /^\/domain\/zone\/[^/]+\/\*$/.test(p))) {
			out.push({ rule, reason: `${rule.method} couvre aussi /reset et /import (vidage ou remplacement de la zone)` });
		} else if (rule.method === 'PUT') out.push({ rule, reason: 'Forge n’a jamais besoin de modifier un enregistrement (PUT)' });
	}
	return out;
}

/** Lien createToken avec les droits minimaux, par zone. */
export function ovhCreateTokenUrl(endpointBase: string, zones: string[], includeDelete: boolean): string {
	const host = new URL(endpointBase).origin;
	const params: string[] = ['GET=/domain/zone', 'GET=/auth/currentCredential'];
	// Zones inconnues (clés OVH pas encore saisies) : règles valables pour toutes les zones.
	for (const z of zones.length ? zones : ['*']) {
		params.push(`GET=/domain/zone/${z}/record`, `GET=/domain/zone/${z}/record/*`, `POST=/domain/zone/${z}/record`, `POST=/domain/zone/${z}/refresh`);
		if (includeDelete) params.push(`DELETE=/domain/zone/${z}/record/*`);
	}
	return `${host}/createToken/?${params.join('&')}`;
}

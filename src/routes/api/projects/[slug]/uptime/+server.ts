import { json } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import type { RequestHandler } from './$types';

/** Disponibilité des adresses du projet (sondes de Forge, chaque minute). */
export const GET: RequestHandler = async ({ params, url }) => {
	const f = forge();
	try {
		const p = f.projects.get(params.slug);
		const range = url.searchParams.get('range') === '7d' ? '7d' : '24h';
		const domains = f.repos.domains.byProject(p.id).map((d) => ({ id: d.id, fqdn: d.fqdn }));
		return json({ range, sleeping: !!p.sleepingSince, domains: f.monitor.forDomains(domains, range) });
	} catch (err) {
		return json({ error: errorMessage(err) }, { status: 400 });
	}
};

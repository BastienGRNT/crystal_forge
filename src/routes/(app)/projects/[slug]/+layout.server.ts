import { error } from '@sveltejs/kit';
import { forge } from '$server/container';
import { UserFacingError } from '$lib/domain/errors';
import { publicProject } from '$server/application/use-cases/views';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ params, depends }) => {
	depends('forge:project');
	const f = forge();
	let p;
	try {
		p = f.projects.get(params.slug);
	} catch (err) {
		if (err instanceof UserFacingError) error(404, err.message);
		throw err;
	}
	const active = f.repos.jobs.activeForProject(p.id);
	return {
		project: publicProject(p),
		domains: f.repos.domains.byProject(p.id).map((d) => ({ id: d.id, fqdn: d.fqdn, status: d.status, mode: d.mode })),
		activeJob: active ? f.jobs.summary(active) : null,
		publicIp: f.settings.get('network.publicIp')
	};
};

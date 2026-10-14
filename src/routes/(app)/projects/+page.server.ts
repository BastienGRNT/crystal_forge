import { forge } from '$server/container';
import { publicProject } from '$server/application/use-cases/views';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const f = forge();
	return {
		projects: f.repos.projects.list().map((p) => ({
			...publicProject(p),
			domains: f.repos.domains.byProject(p.id).map((d) => ({ fqdn: d.fqdn, status: d.status })),
			lastJob: f.jobs.list({ projectId: p.id, limit: 1 })[0] ?? null
		}))
	};
};

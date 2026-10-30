import { forge } from '$server/container';
import { visibleProjects } from '$server/access';
import { publicProject } from '$server/application/use-cases/views';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const f = forge();
	return {
		projects: visibleProjects(f, locals.user!).map((p) => ({
			...publicProject(p),
			domains: f.repos.domains.byProject(p.id).map((d) => ({ fqdn: d.fqdn, status: d.status })),
			lastJob: f.jobs.list({ projectId: p.id, limit: 1 })[0] ?? null
		}))
	};
};

import { forge } from '$server/container';
import { visibleProjects } from '$server/access';
import { publicProject } from '$server/application/use-cases/views';
import { readTags } from '$lib/domain/spaces';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, depends }) => {
	depends('forge:projects');
	const f = forge();
	return {
		projects: visibleProjects(f, locals.user!).map((p) => ({
			...publicProject(p),
			tags: readTags(p.tags),
			domains: f.repos.domains.byProject(p.id).map((d) => ({ fqdn: d.fqdn, status: d.status })),
			lastJob: f.jobs.list({ projectId: p.id, limit: 1 })[0] ?? null
		}))
	};
};

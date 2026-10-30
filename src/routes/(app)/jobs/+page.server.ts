import { forge } from '$server/container';
import { visibleProjectIdList } from '$server/access';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ depends, locals }) => {
	depends('forge:jobs');
	return { jobs: forge().jobs.list({ projectIds: visibleProjectIdList(forge(), locals.user!), limit: 100 }) };
};

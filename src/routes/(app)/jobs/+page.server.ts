import { forge } from '$server/container';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ depends }) => {
	depends('forge:jobs');
	return { jobs: forge().jobs.list({ limit: 100 }) };
};

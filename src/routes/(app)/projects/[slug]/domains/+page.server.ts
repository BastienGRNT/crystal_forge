import { fail, redirect } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const f = forge();
	const p = f.projects.get(params.slug);
	const [view, zones] = await Promise.all([f.projects.domainsView(p), f.wizard.zones()]);
	return { view, zones: zones.zones };
};

export const actions: Actions = {
	add: async ({ params, request }) => {
		const f = forge();
		const d = await request.formData();
		let id: number;
		try {
			id = await f.projects.addDomain(f.projects.get(params.slug), {
				subdomain: String(d.get('subdomain') ?? ''),
				zone: String(d.get('zone') ?? ''),
				managed: d.get('managed') === '1'
			});
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		redirect(303, `/jobs/${id}`);
	},
	repair: async ({ params, request }) => {
		const f = forge();
		const domainId = Number((await request.formData()).get('domainId'));
		let id: number;
		try {
			id = f.projects.repairDomain(f.projects.get(params.slug), domainId);
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		redirect(303, `/jobs/${id}`);
	},
	remove: async ({ params, request }) => {
		const f = forge();
		const domainId = Number((await request.formData()).get('domainId'));
		let id: number;
		try {
			id = f.projects.removeDomain(f.projects.get(params.slug), domainId);
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		redirect(303, `/jobs/${id}`);
	}
};

import { fail, redirect } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const f = forge();
	const p = f.projects.get(params.slug);
	const resources = f.projects.ownedResources(p).map((r) => ({ type: r.type, externalId: r.externalId, meta: JSON.parse(r.meta) as Record<string, unknown> }));
	// Comparaison avec ce que Forge produirait aujourd'hui (GitHub, Proxmox, SSH) : en différé.
	return { resources, upgrade: f.upgrade.view(p) };
};

export const actions: Actions = {
	update: async ({ params, request }) => {
		const f = forge();
		const d = await request.formData();
		let id: number;
		try {
			id = f.projects.updateSettings(
				f.projects.get(params.slug),
				{ appPort: Number(d.get('appPort')), postDeploy: String(d.get('postDeploy') ?? ''), appService: String(d.get('appService') ?? 'app') },
				d.get('redeploy') === 'on'
			);
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		redirect(303, `/jobs/${id}`);
	},
	upgrade: async ({ params, request }) => {
		const f = forge();
		const d = await request.formData();
		let id: number;
		try {
			id = await f.upgrade.apply(f.projects.get(params.slug), d.getAll('items').map(String));
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		redirect(303, `/jobs/${id}`);
	},
	delete: async ({ params, request }) => {
		const f = forge();
		const d = await request.formData();
		let id: number;
		try {
			id = f.projects.delete(f.projects.get(params.slug), String(d.get('confirm') ?? ''), d.get('mode') === 'forget' ? 'forget' : 'full');
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		redirect(303, `/jobs/${id}`);
	}
};

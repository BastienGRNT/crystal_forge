import { fail, redirect } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import type { PowerAction } from '$server/application/ports';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, depends }) => {
	depends('forge:container');
	const f = forge();
	const p = f.projects.get(params.slug);
	const [view, firewall] = await Promise.all([f.projects.containerView(p), f.projects.firewallView(p)]);
	return {
		container: {
			guest: view.guest,
			rootfs: view.config ? String(view.config.rootfs ?? '') : null,
			swap: view.config ? Number(view.config.swap ?? 0) : null,
			onboot: view.config ? Number(view.config.onboot ?? 0) === 1 : null,
			backups: view.backups,
			services: view.services,
			servicesError: view.servicesError
		},
		composePath: f.projects.composePath(p),
		firewall
	};
};

export const actions: Actions = {
	power: async ({ params, request }) => {
		const f = forge();
		const action = String((await request.formData()).get('action')) as PowerAction;
		let id: number;
		try {
			id = f.projects.power(f.projects.get(params.slug), action);
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		redirect(303, `/jobs/${id}`);
	},
	resize: async ({ params, request }) => {
		const f = forge();
		const d = await request.formData();
		let id: number;
		try {
			id = await f.projects.resize(
				f.projects.get(params.slug),
				{ preset: String(d.get('preset') ?? ''), cores: Number(d.get('cores')), memoryMb: Number(d.get('memoryMb')), diskGb: Number(d.get('diskGb')) },
				d.get('acknowledgeRam') === 'on'
			);
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		redirect(303, `/jobs/${id}`);
	},
	firewall: async ({ params }) => {
		const f = forge();
		let id: number;
		try {
			id = f.projects.applyFirewall(f.projects.get(params.slug));
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		redirect(303, `/jobs/${id}`);
	}
};

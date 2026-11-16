import { fail } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ depends }) => {
	depends('forge:spaces');
	const f = forge();
	const projects = f.repos.projects.list();
	const users = f.auth.listUsers().filter((u) => u.role !== 'admin');
	return {
		spaces: f.spaces.list().map((s) => ({
			...s,
			projects: projects.filter((p) => p.spaceId === s.id).map((p) => ({ slug: p.slug, name: p.name, status: p.status })),
			members: users.flatMap((u) => u.spaces.filter((m) => m.spaceId === s.id).map((m) => ({ userId: u.id, username: u.username, level: m.level })))
		})),
		loose: projects.filter((p) => p.spaceId === null).map((p) => ({ slug: p.slug, name: p.name, status: p.status }))
	};
};

const fields = (d: FormData) => ({ name: String(d.get('name') ?? ''), color: String(d.get('color') ?? ''), icon: String(d.get('icon') ?? '') });

export const actions: Actions = {
	create: async ({ request }) => {
		try {
			forge().spaces.create(fields(await request.formData()));
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		return { saved: true };
	},
	update: async ({ request }) => {
		const d = await request.formData();
		try {
			forge().spaces.update(Number(d.get('id')), fields(d));
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		return { saved: true };
	},
	move: async ({ request }) => {
		const d = await request.formData();
		forge().spaces.move(Number(d.get('id')), d.get('dir') === 'up' ? -1 : 1);
		return { saved: true };
	},
	delete: async ({ request }) => {
		const d = await request.formData();
		forge().spaces.delete(Number(d.get('id')));
		return { saved: true };
	},
	/** Ajoute un projet hors espace à cet espace. */
	assign: async ({ request }) => {
		const d = await request.formData();
		const f = forge();
		try {
			const p = f.projects.get(String(d.get('slug') ?? ''));
			f.spaces.organize(p.id, Number(d.get('id')) || null, JSON.parse(p.tags).join(' '));
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		return { saved: true };
	}
};

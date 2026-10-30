import { fail } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import { isAccessLevel } from '$lib/domain/access';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ depends }) => {
	depends('forge:users');
	const f = forge();
	return {
		users: f.auth.listUsers(),
		projects: f.repos.projects.list().map((p) => ({ id: p.id, slug: p.slug, name: p.name })),
		audit: f.audit.recent(60)
	};
};

const id = (d: FormData, key: string) => Number(d.get(key));

export const actions: Actions = {
	create: async ({ request }) => {
		const d = await request.formData();
		try {
			const { user, resetToken } = await forge().auth.createCollaborator(String(d.get('username') ?? ''));
			return { link: { username: user.username, token: resetToken } };
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
	},
	/** Mot de passe oublié : nouveau lien à usage unique. */
	resetLink: async ({ request }) => {
		const d = await request.formData();
		try {
			const f = forge();
			const userId = id(d, 'userId');
			const user = f.auth.listUsers().find((u) => u.id === userId);
			return { link: { username: user?.username ?? '', token: f.auth.createResetLink(userId) } };
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
	},
	member: async ({ request }) => {
		const d = await request.formData();
		const level = String(d.get('level') ?? '');
		try {
			forge().auth.setMember(id(d, 'userId'), id(d, 'projectId'), isAccessLevel(level) ? level : null);
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		return { saved: true };
	},
	toggle: async ({ request }) => {
		const d = await request.formData();
		try {
			forge().auth.setDisabled(id(d, 'userId'), d.get('disabled') === '1');
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		return { saved: true };
	},
	remove: async ({ request }) => {
		const d = await request.formData();
		try {
			forge().auth.deleteUser(id(d, 'userId'));
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		return { saved: true };
	}
};

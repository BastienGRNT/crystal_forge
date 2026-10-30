import { fail } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => ({ username: locals.user!.username, role: locals.user!.role });

export const actions: Actions = {
	password: async ({ request, locals }) => {
		const d = await request.formData();
		const next = String(d.get('next') ?? '');
		if (next !== String(d.get('confirm') ?? '')) return fail(400, { error: 'Les deux mots de passe ne correspondent pas.' });
		try {
			await forge().auth.changePassword(locals.user!.id, String(d.get('current') ?? ''), next);
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		return { passwordChanged: true };
	}
};

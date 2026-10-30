import { fail, redirect } from '@sveltejs/kit';
import { forge } from '$server/container';
import { UserFacingError } from '$lib/domain/errors';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	return { username: forge().auth.resetTarget(params.token) };
};

export const actions: Actions = {
	default: async ({ params, request }) => {
		const data = await request.formData();
		const password = String(data.get('password') ?? '');
		if (password !== String(data.get('confirm') ?? '')) return fail(400, { error: 'Les deux mots de passe ne correspondent pas.' });
		try {
			await forge().auth.resetPassword(params.token, password);
		} catch (err) {
			if (err instanceof UserFacingError) return fail(400, { error: err.message });
			throw err;
		}
		redirect(303, '/login?reset=1');
	}
};

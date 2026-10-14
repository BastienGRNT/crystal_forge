import { fail, redirect } from '@sveltejs/kit';
import { forge } from '$server/container';
import { UserFacingError } from '$lib/domain/errors';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const f = forge();
	if (!f.auth.needsSetup()) redirect(303, '/login');
	return { prefilledToken: f.auth.exposedSetupToken(), mode: f.config.mode };
};

export const actions: Actions = {
	default: async ({ request }) => {
		const data = await request.formData();
		const token = String(data.get('token') ?? '');
		const password = String(data.get('password') ?? '');
		const confirm = String(data.get('confirm') ?? '');
		if (password !== confirm) return fail(400, { error: 'Les deux mots de passe ne correspondent pas.' });
		try {
			await forge().auth.setup(token, password);
		} catch (err) {
			if (err instanceof UserFacingError) return fail(400, { error: err.message });
			throw err;
		}
		redirect(303, '/login?setup=1');
	}
};

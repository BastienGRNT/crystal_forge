import { fail, redirect } from '@sveltejs/kit';
import { forge } from '$server/container';
import { SESSION_COOKIE } from '$server/application/use-cases/auth';
import { UserFacingError } from '$lib/domain/errors';
import { getConfig } from '$server/infrastructure/config';
import type { Actions, PageServerLoad } from './$types';

function safeNext(next: string | null): string {
	return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.authenticated) redirect(303, safeNext(url.searchParams.get('next')));
	return { justSetUp: url.searchParams.has('setup'), mode: forge().config.mode };
};

export const actions: Actions = {
	default: async ({ request, cookies, locals, url }) => {
		const data = await request.formData();
		const password = String(data.get('password') ?? '');
		try {
			const { token, expiresAt } = await forge().auth.login(password, locals.clientIp, request.headers.get('user-agent'));
			cookies.set(SESSION_COOKIE, token, {
				path: '/',
				httpOnly: true,
				sameSite: 'strict',
				secure: getConfig().secureCookies,
				expires: new Date(expiresAt)
			});
		} catch (err) {
			if (err instanceof UserFacingError) return fail(400, { error: err.message });
			throw err;
		}
		redirect(303, safeNext(url.searchParams.get('next')));
	}
};

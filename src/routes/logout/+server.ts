import { redirect } from '@sveltejs/kit';
import { forge } from '$server/container';
import { SESSION_COOKIE } from '$server/application/use-cases/auth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ cookies }) => {
	forge().auth.logout(cookies.get(SESSION_COOKIE));
	cookies.delete(SESSION_COOKIE, { path: '/' });
	redirect(303, '/login');
};

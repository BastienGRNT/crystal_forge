import { json } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		return json({ repos: await forge().wizard.listReposFor(locals.user!, url.searchParams.has('refresh')) });
	} catch (err) {
		return json({ repos: [], error: errorMessage(err) }, { status: 502 });
	}
};

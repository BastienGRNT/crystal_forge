import { json } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	try {
		return json({ repos: await forge().wizard.listRepos(url.searchParams.has('refresh')) });
	} catch (err) {
		return json({ repos: [], error: errorMessage(err) }, { status: 502 });
	}
};

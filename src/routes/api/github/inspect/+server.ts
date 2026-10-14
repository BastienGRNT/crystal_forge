import { json } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const repo = url.searchParams.get('repo') ?? '';
	try {
		return json(await forge().wizard.inspect(repo, url.searchParams.get('workdir') ?? '.'));
	} catch (err) {
		return json({ error: errorMessage(err) }, { status: 400 });
	}
};

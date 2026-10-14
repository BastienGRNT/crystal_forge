import { json } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url }) => {
	const f = forge();
	try {
		const p = f.projects.get(params.slug);
		const result = await f.database.browse(p, url.searchParams.get('schema') ?? 'public', url.searchParams.get('table') ?? '', Number(url.searchParams.get('page') ?? 0));
		return json(result);
	} catch (err) {
		return json({ error: errorMessage(err) }, { status: 400 });
	}
};

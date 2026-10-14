import { json } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const f = forge();
	try {
		return json(await f.projects.runDetail(f.projects.get(params.slug), Number(params.runId)));
	} catch (err) {
		return json({ error: errorMessage(err) }, { status: 400 });
	}
};

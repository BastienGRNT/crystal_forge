import { json } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import type { RequestHandler } from './$types';

/** docker compose logs --tail (lecture seule, autorisée en DRY_RUN). */
export const GET: RequestHandler = async ({ params, url }) => {
	const f = forge();
	try {
		const p = f.projects.get(params.slug);
		const tail = Number(url.searchParams.get('tail') ?? 200);
		const service = url.searchParams.get('service') || undefined;
		return json({ text: await f.projects.containerLogs(p, tail, service) });
	} catch (err) {
		return json({ error: errorMessage(err) }, { status: 400 });
	}
};

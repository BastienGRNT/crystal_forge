import { error } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import type { RequestHandler } from './$types';

/** Téléchargement d'un dump SQL (gzip) depuis le CT du projet. */
export const GET: RequestHandler = async ({ params }) => {
	const f = forge();
	let data: Buffer;
	try {
		data = await f.database.download(f.projects.get(params.slug), params.name);
	} catch (err) {
		error(400, errorMessage(err));
	}
	return new Response(new Uint8Array(data), {
		headers: {
			'Content-Type': 'application/gzip',
			'Content-Disposition': `attachment; filename="${params.slug}-${params.name}"`,
			'Cache-Control': 'no-store'
		}
	});
};

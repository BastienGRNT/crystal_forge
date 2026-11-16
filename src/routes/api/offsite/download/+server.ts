import { error } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import type { RequestHandler } from './$types';

/**
 * Télécharge une copie R2 en clair (restic la déchiffre à la volée). Admin uniquement :
 * la route n'est pas listée dans access.ts, donc réservée à l'admin par défaut.
 */
export const GET: RequestHandler = async ({ url }) => {
	const id = url.searchParams.get('snapshot') ?? '';
	let file: Awaited<ReturnType<ReturnType<typeof forge>['offsite']['download']>>;
	try {
		file = await forge().offsite.download(id);
	} catch (err) {
		error(400, errorMessage(err));
	}
	return new Response(file.stream, {
		headers: {
			'content-type': 'application/octet-stream',
			'content-disposition': `attachment; filename="${file.filename.replace(/[^\w.-]/g, '_')}"`,
			'cache-control': 'no-store'
		}
	});
};

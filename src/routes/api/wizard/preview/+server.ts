import { json } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import { isSizeKey } from '$lib/domain/sizes';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const size = url.searchParams.get('size') ?? 'M';
	try {
		return json(await forge().wizard.preview(isSizeKey(size) ? size : 'M'));
	} catch (err) {
		return json({ error: errorMessage(err) }, { status: 502 });
	}
};

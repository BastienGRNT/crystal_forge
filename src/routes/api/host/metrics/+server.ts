import { json } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import { parseRange, RANGE_TIMEFRAME, toSeries } from '$server/application/use-cases/metrics';
import type { RequestHandler } from './$types';

/** Historique du serveur Proxmox entier (admin : route non listée dans access.ts). */
export const GET: RequestHandler = async ({ url }) => {
	const range = parseRange(url.searchParams.get('range'));
	try {
		return json(toSeries(range, await forge().proxmox.rrd(null, RANGE_TIMEFRAME[range])));
	} catch (err) {
		return json({ error: errorMessage(err) }, { status: 400 });
	}
};

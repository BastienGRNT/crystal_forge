import { json } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import { parseRange, RANGE_TIMEFRAME, toSeries } from '$server/application/use-cases/metrics';
import type { RequestHandler } from './$types';

/** Historique CPU/RAM/réseau du CT (lecture Proxmox, autorisée en DRY_RUN). */
export const GET: RequestHandler = async ({ params, url }) => {
	const f = forge();
	const range = parseRange(url.searchParams.get('range'));
	try {
		const p = f.projects.get(params.slug);
		if (!p.ctid) return json({ range, points: [], maxmem: null, maxcpu: null });
		return json(toSeries(range, await f.proxmox.rrd(p.ctid, RANGE_TIMEFRAME[range])));
	} catch (err) {
		return json({ error: errorMessage(err) }, { status: 400 });
	}
};

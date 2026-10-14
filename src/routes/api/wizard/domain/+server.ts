import { json } from '@sveltejs/kit';
import { forge } from '$server/container';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const sub = url.searchParams.get('sub') ?? '';
	const zone = url.searchParams.get('zone') ?? '';
	const managed = url.searchParams.get('managed') === '1';
	return json(await forge().wizard.checkDomain(sub, zone, managed));
};

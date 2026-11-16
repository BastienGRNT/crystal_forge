import { json } from '@sveltejs/kit';
import { forge } from '$server/container';
import type { RequestHandler } from './$types';

/** La cloche a été ouverte : tout ce qui précède est lu. */
export const POST: RequestHandler = ({ locals }) => {
	forge().auth.markNotificationsSeen(locals.user!.id);
	return json({ ok: true });
};

import { json } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import type { RequestHandler } from './$types';

/**
 * Console web du CT : réservée à l'admin (route absente de access.ts → admin par défaut).
 * Corps JSON { command, cwd } ; la commande passe par le garde (DRY_RUN) et la liste noire.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const body = (await request.json()) as { command?: unknown; cwd?: unknown };
		const p = forge().projects.get(params.slug);
		return json(await forge().projects.consoleExec(p, typeof body.cwd === 'string' ? body.cwd : '', typeof body.command === 'string' ? body.command : ''));
	} catch (err) {
		return json({ error: errorMessage(err) }, { status: 400 });
	}
};

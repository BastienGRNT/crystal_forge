import { error } from '@sveltejs/kit';
import { forge } from '$server/container';
import type { RequestHandler } from './$types';

/** Flux SSE d'un job : logs et changements de statut en direct. */
export const GET: RequestHandler = ({ params, url, request }) => {
	const f = forge();
	const id = Number(params.id);
	if (!f.jobs.view(id)) error(404, 'Job introuvable');
	let after = Number(url.searchParams.get('after') ?? 0);
	const enc = new TextEncoder();

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			const send = (event: string, data: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					cleanup();
				}
			};
			// Rattrapage : logs écrits entre le chargement de la page et l'ouverture du flux.
			for (const log of f.repos.jobs.logs(id, after)) {
				send('log', log);
				after = log.id;
			}
			send('job', f.jobs.view(id));

			const off = f.events.onJob(id, (e) => {
				if (e.kind === 'log') {
					if (e.log.id <= after) return;
					after = e.log.id;
					send('log', e.log);
				} else send('job', f.jobs.view(id));
			});
			const ping = setInterval(() => {
				if (!closed) controller.enqueue(enc.encode(`: ping\n\n`));
			}, 15_000);
			function cleanup() {
				if (closed) return;
				closed = true;
				off();
				clearInterval(ping);
				try {
					controller.close();
				} catch {
					/* déjà fermé */
				}
			}
			request.signal.addEventListener('abort', cleanup);
		}
	});

	return new Response(stream, {
		headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' }
	});
};

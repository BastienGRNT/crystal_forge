import { forge } from '$server/container';
import { levelAtLeast } from '$lib/domain/access';
import type { RequestHandler } from './$types';

/**
 * Flux SSE global, ouvert une fois par onglet : « tel job a changé de statut ».
 * L'interface s'en sert pour se rafraîchir (barre latérale, listes, projet ouvert)
 * au lieu de sonder. Un collaborateur ne reçoit que les jobs de ses projets.
 */
export const GET: RequestHandler = ({ request, locals }) => {
	const f = forge();
	const user = locals.user;
	const enc = new TextEncoder();
	const visible = (projectId: number | null) => !!user && (user.role === 'admin' || (projectId != null && levelAtLeast(f.auth.levelFor(user, projectId), 'read')));

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			const write = (chunk: string) => {
				if (closed) return;
				try {
					controller.enqueue(enc.encode(chunk));
				} catch {
					cleanup();
				}
			};
			const off = f.events.onAnyJobStatus((jobId) => {
				const job = f.repos.jobs.get(jobId);
				if (!job || !visible(job.projectId)) return;
				const slug = job.projectId != null ? (f.repos.projects.get(job.projectId)?.slug ?? null) : null;
				write(`event: job\ndata: ${JSON.stringify({ id: job.id, status: job.status, projectId: job.projectId, slug })}\n\n`);
			});
			const ping = setInterval(() => write(': ping\n\n'), 20_000);
			write(': ok\n\n');
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

/**
 * Page « réveil en cours » des serveurs de dev endormis, sur un port à part (WAKE_PORT).
 * Elle n'accepte que NPM (et la machine elle-même) et ne fait qu'une chose : réveiller le
 * projet dont le domaine est demandé. Aucune page de Forge n'est servie ici.
 */
import { createServer, type Server } from 'node:http';
import { WAKE_PORT, wakePageHtml } from '$lib/domain/sleep';

export interface WakeDeps {
	/** IP de NPM (seule source acceptée, avec 127.0.0.1). */
	npmIp: () => string;
	/** Projet endormi servi par ce domaine (null sinon). */
	projectForHost: (host: string) => { id: number; name: string; sleeping: boolean } | null;
	wake: (projectId: number) => void;
	wakeError: (projectId: number) => string | null;
}

export function startWakeServer(d: WakeDeps, port = WAKE_PORT): Server {
	const server = createServer((req, res) => {
		const from = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
		if (from !== d.npmIp() && from !== '127.0.0.1') {
			res.writeHead(403).end();
			return;
		}
		const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
		const p = /^[a-z0-9.-]{1,253}$/.test(host) ? d.projectForHost(host) : null;
		if (!p) {
			res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Inconnu.');
			return;
		}
		if (p.sleeping) d.wake(p.id);
		res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '4' });
		res.end(wakePageHtml(p.name, p.sleeping ? d.wakeError(p.id) : null));
	});
	server.on('error', (err) => console.warn(`[veille] Page de réveil indisponible (port ${port}) : ${err.message}`));
	server.listen(port, '0.0.0.0');
	return server;
}

import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { NetworkProbe } from './probe';

it('connectTo : se connecte à l’IP donnée en gardant le nom de domaine (Host)', async () => {
	let host = '';
	const srv = createServer((req, res) => {
		host = req.headers.host ?? '';
		res.end('ok');
	});
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
	const port = (srv.address() as { port: number }).port;
	try {
		const res = await new NetworkProbe().http(`http://app.forge-test.invalid:${port}/`, 3000, { connectTo: '127.0.0.1' });
		expect(res).toMatchObject({ ok: true, status: 200 });
		expect(host).toBe(`app.forge-test.invalid:${port}`);
	} finally {
		srv.close();
	}
});

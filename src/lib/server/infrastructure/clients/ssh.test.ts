import type { AddressInfo } from 'node:net';
import ssh2 from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SshTarget } from '$server/application/ports';
import { fingerprint, generateForgeKeyPair, SshClient } from './ssh';

/**
 * Serveur SSH en mémoire. Commandes reconnues :
 *   « echo X » → X, code 0 ; « exit N » → code N ; « drop » → coupe la connexion sans code ;
 *   « sleep N » → répond après N ms.
 */
const hostKey = ssh2.utils.generateKeyPairSync('ed25519');
const clientKey = generateForgeKeyPair('test');
let server: ssh2.Server;
let port = 0;
let connections = 0;
const clients = new Set<ssh2.Connection>();

beforeAll(async () => {
	server = new ssh2.Server({ hostKeys: [hostKey.private] }, (client) => {
		connections++;
		clients.add(client);
		client.on('close', () => clients.delete(client));
		client.on('error', () => {});
		client.on('authentication', (ctx) => (ctx.method === 'publickey' ? ctx.accept() : ctx.reject(['publickey'])));
		client.on('session', (accept) => {
			accept().on('exec', (acceptExec, _reject, info) => {
				const stream = acceptExec();
				const [cmd, arg = ''] = info.command.split(' ');
				if (cmd === 'echo') {
					stream.write(arg);
					stream.exit(0);
					stream.end();
				} else if (cmd === 'exit') {
					stream.stderr.write('échec');
					stream.exit(Number(arg));
					stream.end();
				} else if (cmd === 'sleep') {
					setTimeout(() => {
						stream.write('fini');
						stream.exit(0);
						stream.end();
					}, Number(arg));
				} else if (cmd === 'drop') {
					client.end();
				}
			});
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	port = (server.address() as AddressInfo).port;
});

afterAll(() => {
	for (const c of clients) c.end();
	server.close();
});

const target = (over: Partial<SshTarget> = {}): SshTarget => ({ host: '127.0.0.1', port, user: 'github', privateKey: clientKey.privateKey, expectedHostKey: null, ...over });
const hostFingerprint = () => fingerprint((ssh2.utils.parseKey(hostKey.public) as ssh2.ParsedKey).getPublicSSH());

describe('SshClient (connexions réutilisées)', () => {
	it('enchaîne et parallélise les commandes sur UNE connexion', async () => {
		const ssh = new SshClient();
		const before = connections;
		const first = await ssh.exec(target(), 'echo un');
		const parallel = await Promise.all(['a', 'b', 'c', 'd'].map((x) => ssh.exec(target(), `echo ${x}`)));
		expect(first).toMatchObject({ code: 0, stdout: 'un' });
		expect(parallel.map((r) => r.stdout)).toEqual(['a', 'b', 'c', 'd']);
		expect(first.hostKey).toBe(hostFingerprint());
		expect(connections - before).toBe(1);
	});

	it('renvoie le code de sortie et stderr', async () => {
		const res = await new SshClient().exec(target(), 'exit 3');
		expect(res).toMatchObject({ code: 3, stderr: 'échec' });
	});

	it('une connexion coupée pendant la commande est une ERREUR, jamais un succès', async () => {
		await expect(new SshClient().exec(target(), 'drop')).rejects.toThrow(/SSH/);
	});

	it('reconnecte si la connexion gardée a été fermée côté serveur', async () => {
		const ssh = new SshClient();
		await ssh.exec(target(), 'echo un');
		for (const c of clients) c.end();
		await new Promise((r) => setTimeout(r, 50));
		expect((await ssh.exec(target(), 'echo deux')).stdout).toBe('deux');
	});

	it('refuse une clé d’hôte différente de celle enregistrée', async () => {
		await expect(new SshClient().exec(target({ expectedHostKey: 'SHA256:autre' }), 'echo x')).rejects.toThrow(/a changé/);
	});

	it('délai dépassé : erreur, et la connexion reste utilisable', async () => {
		const ssh = new SshClient();
		await expect(ssh.exec(target(), 'sleep 500', { timeoutMs: 50 })).rejects.toThrow(/délai dépassé/);
		expect((await ssh.exec(target(), 'echo ok')).stdout).toBe('ok');
	});
});

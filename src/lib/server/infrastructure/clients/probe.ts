/** Sondes réseau (lecture seule) : ping, ARP, TCP, HTTP et résolution DNS publique (DoH). */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import type { LookupFunction } from 'node:net';
import { Agent, fetch } from 'undici';
import { isIpv4 } from '$lib/domain/network';
import type { ProbeApi, ResolverApi } from '$server/application/ports';

export class NetworkProbe implements ProbeApi {
	ping(ip: string): Promise<boolean> {
		if (!isIpv4(ip)) return Promise.resolve(false);
		return new Promise((resolve) => {
			execFile('ping', ['-c', '1', '-W', '1', ip], { timeout: 3000 }, (err) => resolve(!err));
		});
	}

	async arpHas(ip: string): Promise<boolean | null> {
		try {
			const table = await readFile('/proc/net/arp', 'utf8');
			const lines = table.split('\n').slice(1).filter(Boolean);
			const row = lines.find((l) => l.split(/\s+/)[0] === ip);
			if (!row) return false;
			const mac = row.split(/\s+/)[3];
			return !!mac && mac !== '00:00:00:00:00:00';
		} catch {
			return null;
		}
	}

	tcpOpen(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
		return new Promise((resolve) => {
			const s = connect({ host, port });
			const done = (v: boolean) => {
				s.destroy();
				resolve(v);
			};
			s.setTimeout(timeoutMs, () => done(false));
			s.once('connect', () => done(true));
			s.once('error', () => done(false));
		});
	}

	async http(url: string, timeoutMs = 10_000, opts: { connectTo?: string } = {}) {
		const start = Date.now();
		const ip = opts.connectTo && isIpv4(opts.connectTo) ? opts.connectTo : null;
		// Résolution forcée : la connexion part vers `ip`, le nom reste celui de l'URL (SNI, certificat, Host).
		const lookup: LookupFunction = (_host, o, cb) => (o.all ? cb(null, [{ address: ip as string, family: 4 }]) : cb(null, ip as string, 4));
		const dispatcher = ip ? new Agent({ connect: { lookup } as never }) : undefined;
		try {
			const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), dispatcher });
			await res.body?.cancel();
			return { ok: res.status < 500, status: res.status, error: null, ms: Date.now() - start };
		} catch (err) {
			const cause = (err as { cause?: { code?: string; message?: string } }).cause;
			return { ok: false, status: null, error: cause?.code ?? cause?.message ?? (err as Error).message, ms: Date.now() - start };
		} finally {
			await dispatcher?.close().catch(() => {});
		}
	}
}

/** Résolution publique via DNS-over-HTTPS de Google. */
export class DohResolver implements ResolverApi {
	async resolveA(name: string): Promise<string[]> {
		const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=A`, {
			headers: { accept: 'application/dns-json' },
			signal: AbortSignal.timeout(8000)
		});
		if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);
		const j = (await res.json()) as { Status: number; Answer?: { type: number; data: string }[] };
		return (j.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
	}
}

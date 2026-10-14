/** Outils IPv4 et lecture de la config réseau Proxmox (net0, net1…). */

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIpv4(value: string): boolean {
	return IPV4_RE.test(value);
}

export function ipToInt(ip: string): number {
	if (!isIpv4(ip)) throw new Error(`IPv4 invalide : ${ip}`);
	return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

export function intToIp(n: number): string {
	return [24, 16, 8, 0].map((shift) => (n >>> shift) & 0xff).join('.');
}

export function inCidr(ip: string, cidr: string): boolean {
	const [base, bitsRaw] = cidr.split('/');
	const bits = Number(bitsRaw ?? 32);
	if (!base || !isIpv4(ip) || !isIpv4(base) || bits < 0 || bits > 32) return false;
	if (bits === 0) return true;
	const mask = (~0 << (32 - bits)) >>> 0;
	return (ipToInt(ip) & mask) === (ipToInt(base) & mask);
}

export interface NetConfig {
	name?: string;
	bridge?: string;
	ip?: string; // sans le /CIDR
	cidr?: number;
	gw?: string;
	raw: string;
}

/** Parse une valeur Proxmox du type « name=eth0,bridge=nat,ip=10.10.10.41/24,gw=10.10.10.1 ». */
export function parseNetConfig(raw: string): NetConfig {
	const out: NetConfig = { raw };
	for (const part of raw.split(',')) {
		const idx = part.indexOf('=');
		if (idx < 0) continue;
		const key = part.slice(0, idx).trim();
		const value = part.slice(idx + 1).trim();
		if (key === 'name') out.name = value;
		else if (key === 'bridge') out.bridge = value;
		else if (key === 'gw') out.gw = value;
		else if (key === 'ip') {
			const [addr, mask] = value.split('/');
			if (addr && isIpv4(addr)) {
				out.ip = addr;
				if (mask) out.cidr = Number(mask);
			}
		}
	}
	return out;
}

/** Toutes les IPv4 déclarées dans une config de CT/VM (clés net0..netN, ipconfigN pour les VM). */
export function ipsFromGuestConfig(config: Record<string, unknown>): string[] {
	const ips: string[] = [];
	for (const [key, value] of Object.entries(config)) {
		if (typeof value !== 'string') continue;
		if (/^net\d+$/.test(key) || /^ipconfig\d+$/.test(key)) {
			const parsed = parseNetConfig(value);
			if (parsed.ip) ips.push(parsed.ip);
		}
	}
	return ips;
}

export function buildNet0(opts: { ip: string; cidr: number; gateway: string; bridge: string }): string {
	return `name=eth0,bridge=${opts.bridge},ip=${opts.ip}/${opts.cidr},gw=${opts.gateway}`;
}

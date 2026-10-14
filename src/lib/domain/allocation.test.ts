import { describe, expect, it } from 'vitest';
import { candidateIps, nextFreeCtid, pickFreeIp } from './allocation';
import { inCidr, ipsFromGuestConfig, parseNetConfig } from './network';

describe('nextFreeCtid', () => {
	it('prend le premier ID libre de la plage', () => {
		expect(nextFreeCtid([100, 401, 500, 501], { min: 500, max: 599 })).toBe(502);
	});
	it('ignore les IDs hors plage et tient compte des réservations', () => {
		expect(nextFreeCtid([100, 900], { min: 500, max: 599 }, [500])).toBe(501);
	});
	it('renvoie null quand la plage est pleine', () => {
		const used = Array.from({ length: 100 }, (_, i) => 500 + i);
		expect(nextFreeCtid(used, { min: 500, max: 599 })).toBeNull();
	});
});

describe('candidateIps', () => {
	const range = { start: '10.10.10.60', end: '10.10.10.99' };
	it('exclut les IP utilisées et réservées', () => {
		const c = candidateIps(['10.10.10.60', '10.10.10.41'], range, ['10.10.10.61']);
		expect(c[0]).toBe('10.10.10.62');
		expect(c).not.toContain('10.10.10.60');
		expect(c).toHaveLength(38);
	});
	it("n'attribue jamais 10.10.10.50 même si la plage l'inclut", () => {
		const c = candidateIps([], { start: '10.10.10.45', end: '10.10.10.55' }, ['10.10.10.50']);
		expect(c).not.toContain('10.10.10.50');
	});
	it('refuse une plage inversée', () => {
		expect(() => candidateIps([], { start: '10.10.10.99', end: '10.10.10.60' })).toThrow();
	});
});

describe('pickFreeIp', () => {
	it("saute les IP qui répondent au ping alors qu'aucune config ne les déclare", async () => {
		const alive = new Set(['10.10.10.60', '10.10.10.61']);
		const res = await pickFreeIp(['10.10.10.60', '10.10.10.61', '10.10.10.62'], async (ip) => alive.has(ip));
		expect(res.ip).toBe('10.10.10.62');
		expect(res.skipped).toEqual(['10.10.10.60', '10.10.10.61']);
	});
	it('renvoie null si tout répond', async () => {
		const res = await pickFreeIp(['10.10.10.60'], async () => true);
		expect(res.ip).toBeNull();
	});
});

describe('config réseau Proxmox', () => {
	it('parse net0', () => {
		const n = parseNetConfig('name=eth0,bridge=nat,firewall=1,gw=10.10.10.1,hwaddr=BC:24:11:00:00:01,ip=10.10.10.41/24,type=veth');
		expect(n).toMatchObject({ name: 'eth0', bridge: 'nat', ip: '10.10.10.41', cidr: 24, gw: '10.10.10.1' });
	});
	it('ignore ip=dhcp / manual', () => {
		expect(parseNetConfig('name=eth0,bridge=nat,ip=dhcp').ip).toBeUndefined();
		expect(parseNetConfig('name=eth0,bridge=nat,ip=manual').ip).toBeUndefined();
	});
	it('lit toutes les interfaces et les ipconfig de VM', () => {
		const ips = ipsFromGuestConfig({
			net0: 'name=eth0,bridge=nat,ip=10.10.10.2/24',
			net1: 'name=eth1,bridge=vmbr0,ip=51.68.180.212/32',
			ipconfig0: 'ip=10.10.10.70/24,gw=10.10.10.1',
			hostname: 'x'
		});
		expect(ips.sort()).toEqual(['10.10.10.2', '10.10.10.70', '51.68.180.212']);
	});
	it('inCidr', () => {
		expect(inCidr('100.77.79.45', '100.64.0.0/10')).toBe(true);
		expect(inCidr('10.10.10.42', '10.10.10.1/32')).toBe(false);
		expect(inCidr('10.10.10.1', '10.10.10.1/32')).toBe(true);
	});
});

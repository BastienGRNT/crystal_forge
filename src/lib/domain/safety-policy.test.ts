import { describe, expect, it } from 'vitest';
import {
	assertCanCloneCt,
	assertCanCreateDnsRecord,
	assertCanCreateProxyHost,
	assertCanRepointProxyHost,
	assertCanModifyCt,
	assertOwned,
	assertSafeCommand,
	assertSafeCtConfig,
	assertSshTarget,
	wildcardCovering,
	type SafetyContext
} from './safety-policy';
import { SafetyViolation } from './errors';

const ctx: SafetyContext = {
	ctidRange: { min: 500, max: 599 },
	ipRange: { start: '10.10.10.60', end: '10.10.10.99' },
	pool: 'forge',
	templateId: 900,
	bridge: 'nat',
	publicIp: '51.68.180.212',
	protectedCtids: [100, 101, 401, 402, 403, 404],
	reservedIps: ['10.10.10.50']
};
const owned = [{ type: 'pve_ct' as const, externalId: '500', projectId: 1 }];

describe('CT Proxmox', () => {
	it('autorise un CT Forge du pool créé par Forge', () => {
		expect(() => assertCanModifyCt(ctx, { vmid: 500, pool: 'forge', template: false, exists: true }, owned)).not.toThrow();
	});
	it.each([100, 101, 401, 402, 403, 404])('refuse toujours le CT de prod %i', (vmid) => {
		expect(() => assertCanModifyCt(ctx, { vmid, pool: 'forge', template: false, exists: true }, owned)).toThrow(SafetyViolation);
	});
	it('refuse le template, un CT hors pool, hors plage ou non créé par Forge', () => {
		expect(() => assertCanModifyCt(ctx, { vmid: 900, pool: 'forge', template: true, exists: true }, owned)).toThrow(/template/);
		expect(() => assertCanModifyCt(ctx, { vmid: 500, pool: null, template: false, exists: true }, owned)).toThrow(/pool/);
		expect(() => assertCanModifyCt(ctx, { vmid: 650, pool: 'forge', template: false, exists: true }, owned)).toThrow(/plage/);
		expect(() => assertCanModifyCt(ctx, { vmid: 501, pool: 'forge', template: false, exists: true }, owned)).toThrow(/créé par Forge/);
	});
	it('clone : uniquement depuis le template 900, vers un ID libre de la plage et dans le pool', () => {
		expect(() => assertCanCloneCt(ctx, { sourceId: 900, newId: 501, pool: 'forge', existingIds: [500] })).not.toThrow();
		expect(() => assertCanCloneCt(ctx, { sourceId: 401, newId: 501, pool: 'forge', existingIds: [] })).toThrow();
		expect(() => assertCanCloneCt(ctx, { sourceId: 900, newId: 500, pool: 'forge', existingIds: [500] })).toThrow();
		expect(() => assertCanCloneCt(ctx, { sourceId: 900, newId: 404, pool: 'forge', existingIds: [] })).toThrow();
		expect(() => assertCanCloneCt(ctx, { sourceId: 900, newId: 501, pool: 'prod', existingIds: [] })).toThrow();
	});
	it('config : bridge nat, IP de la plage, pas de clé dangereuse', () => {
		const net0 = 'name=eth0,bridge=nat,ip=10.10.10.61/24,gw=10.10.10.1';
		expect(() => assertSafeCtConfig(ctx, { net0, cores: 2 }, [])).not.toThrow();
		expect(() => assertSafeCtConfig(ctx, { net0: net0.replace('nat', 'vmbr0') }, [])).toThrow(/bridge/);
		expect(() => assertSafeCtConfig(ctx, { net0: net0.replace('.61', '.50') }, [])).toThrow();
		expect(() => assertSafeCtConfig(ctx, { net0 }, ['10.10.10.61'])).toThrow(/déjà utilisée/);
		expect(() => assertSafeCtConfig(ctx, { features: 'nesting=1' }, [])).toThrow(/interdite/);
		expect(() => assertSafeCtConfig(ctx, { mp0: '/host,mp=/mnt' }, [])).toThrow(/interdite/);
	});
});

describe('DNS', () => {
	const existing = [
		{ id: 1, fieldType: 'A', subDomain: 'wallet', target: '51.68.180.212' },
		{ id: 2, fieldType: 'TXT', subDomain: 'notes', target: 'v=spf1' },
		{ id: 3, fieldType: 'CNAME', subDomain: 'www', target: 'bastiengrnt.fr.' },
		{ id: 4, fieldType: 'A', subDomain: '*.lab', target: '1.2.3.4' }
	];
	const base = { zone: 'bastiengrnt.fr', fieldType: 'A', target: '51.68.180.212' };
	it('autorise un A vers l’IP publique sur un nom libre', () => {
		expect(() => assertCanCreateDnsRecord(ctx, { ...base, subDomain: 'notes' }, existing)).not.toThrow();
	});
	it("refuse AAAA, une autre cible, ou un nom déjà pris (A/CNAME)", () => {
		expect(() => assertCanCreateDnsRecord(ctx, { ...base, subDomain: 'x', fieldType: 'AAAA' }, existing)).toThrow(/AAAA/);
		expect(() => assertCanCreateDnsRecord(ctx, { ...base, subDomain: 'x', target: '1.1.1.1' }, existing)).toThrow();
		expect(() => assertCanCreateDnsRecord(ctx, { ...base, subDomain: 'wallet' }, existing)).toThrow(/rien n'est écrasé/);
		expect(() => assertCanCreateDnsRecord(ctx, { ...base, subDomain: 'WWW' }, existing)).toThrow();
	});
	it('refuse tout enregistrement tant que l’IP publique n’est pas définie', () => {
		expect(() => assertCanCreateDnsRecord({ ...ctx, publicIp: '' }, { ...base, subDomain: 'x', target: '' }, existing)).toThrow(/IP publique/);
	});
	it('signale un wildcard qui couvre le nom', () => {
		expect(wildcardCovering('app.lab', existing)?.id).toBe(4);
		expect(wildcardCovering('app', existing)).toBeUndefined();
	});
});

describe('NPM / ressources possédées', () => {
	it('refuse un proxy host vers un CT non Forge ou un domaine déjà pris', () => {
		expect(() => assertCanCreateProxyHost(ctx, { domainNames: ['notes.bastiengrnt.fr'], forwardHost: '10.10.10.60', forwardPort: 3000 }, ['wallet.bastiengrnt.fr'])).not.toThrow();
		expect(() => assertCanCreateProxyHost(ctx, { domainNames: ['x.fr'], forwardHost: '10.10.10.42', forwardPort: 3000 }, [])).toThrow();
		expect(() => assertCanCreateProxyHost(ctx, { domainNames: ['Wallet.bastiengrnt.fr'], forwardHost: '10.10.10.60', forwardPort: 3000 }, ['wallet.bastiengrnt.fr'])).toThrow(/existe déjà/);
	});
	it('ne change que le port d’un proxy host Forge, vers le même CT', () => {
		const own = [{ type: 'npm_proxy_host' as const, externalId: '12', projectId: 1 }];
		const host = { id: 12, forwardHost: '10.10.10.61' };
		expect(() => assertCanRepointProxyHost(ctx, host, { forwardHost: '10.10.10.61', forwardPort: 3000 }, own)).not.toThrow();
		expect(() => assertCanRepointProxyHost(ctx, { id: 19, forwardHost: '10.10.10.42' }, { forwardHost: '10.10.10.42', forwardPort: 3000 }, own)).toThrow(/pas été créé par Forge/);
		expect(() => assertCanRepointProxyHost(ctx, host, { forwardHost: '10.10.10.62', forwardPort: 3000 }, own)).toThrow(/seul son port/);
		expect(() => assertCanRepointProxyHost(ctx, { id: 12, forwardHost: '10.10.10.42' }, { forwardHost: '10.10.10.42', forwardPort: 3000 }, own)).toThrow(/pas un CT Forge/);
		expect(() => assertCanRepointProxyHost(ctx, host, { forwardHost: '10.10.10.61', forwardPort: 70000 }, own)).toThrow(/Port invalide/);
	});
	it("refuse de supprimer une ressource qu'il n'a pas créée", () => {
		const own = [{ type: 'npm_proxy_host' as const, externalId: '12', projectId: 1 }];
		expect(() => assertOwned('npm_proxy_host', 12, own, 'Proxy host')).not.toThrow();
		expect(() => assertOwned('npm_proxy_host', 3, own, 'Proxy host')).toThrow(/pas été créé par Forge/);
		expect(() => assertOwned('ovh_record', 12, own, 'Record')).toThrow();
	});
});

describe('commandes', () => {
	it.each([
		'docker compose down -v',
		'docker compose -f x.yml down --volumes',
		'docker volume rm data',
		'docker volume prune -f',
		'docker system prune -a --volumes',
		'docker rm -fv app',
		'rm -rf /'
	])('refuse « %s »', (cmd) => {
		expect(() => assertSafeCommand(cmd)).toThrow(SafetyViolation);
	});
	it.each(['docker compose ps', 'docker compose logs --tail 200', 'docker compose down', 'docker image prune -f', 'npx drizzle-kit migrate'])(
		'autorise « %s »',
		(cmd) => {
			expect(() => assertSafeCommand(cmd)).not.toThrow();
		}
	);
	it('SSH uniquement vers une IP de projet Forge', () => {
		expect(() => assertSshTarget(ctx, '10.10.10.60', ['10.10.10.60'])).not.toThrow();
		expect(() => assertSshTarget(ctx, '10.10.10.42', ['10.10.10.42'])).toThrow();
		expect(() => assertSshTarget(ctx, '10.10.10.61', ['10.10.10.60'])).toThrow();
	});
});

import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeApis } from '$server/infrastructure/mock/fake-apis';
import { resetWorld, world } from '$server/infrastructure/mock/world';
import { DbCommand, ProxmoxGateway, ProxyGateway } from './gateways';
import { WriteGuard } from './guard';
import { SettingsService, type SettingsStore } from './settings';

const CTID = 502;
const IP = '10.10.10.70';

function memoryStore(): SettingsStore {
	const rows = new Map<string, { value: string; isSecret: boolean }>();
	return {
		all: () => [...rows.entries()].map(([key, r]) => ({ key, ...r })),
		get: (key) => rows.get(key),
		set: (key, value, isSecret) => void rows.set(key, { value, isSecret }),
		delete: (key) => void rows.delete(key)
	};
}

/** Passerelle Proxmox réelle (garde hors DRY_RUN) branchée sur le monde simulé. */
function gateway() {
	const apis = createFakeApis();
	const settings = new SettingsService(memoryStore(), { encrypt: (s) => s, decrypt: (s) => s });
	settings.set({ 'safety.protectedCtids': '100,101,401,402,403,404', 'proxmox.node': 'ns3125740' });
	const guard = new WriteGuard(() => false, (s) => s);
	const ownership = { owned: () => [{ type: 'pve_ct' as const, externalId: String(CTID), projectId: 1 }] };
	const projects = { forgeIps: () => [IP], forgeRepos: () => [] };
	return new ProxmoxGateway({ apis: () => apis, guard, settings, ownership, projects });
}

/** Termine immédiatement une tâche simulée. */
async function finish(pve: ProxmoxGateway, upid: string) {
	const t = world().tasks.get(upid);
	if (t) t.startedAt = 0;
	await pve.waitTask(upid);
}

describe('ProxmoxGateway — CT cloné depuis un template protégé', () => {
	beforeEach(() => resetWorld());

	it('le clone hérite de protection=1, comme sur Proxmox', async () => {
		const pve = gateway();
		await finish(pve, await pve.cloneTemplate(CTID, 'demo', 'test'));
		expect(world().guests.get(900)?.config.protection).toBe(1);
		expect(world().guests.get(CTID)?.config.protection).toBe(1);
		await expect(pve.api.destroy(CTID)).rejects.toThrow(/protection mode enabled/);
	});

	it('clone → configure (étape Conteneur) → destroy réussit', async () => {
		const pve = gateway();
		await finish(pve, await pve.cloneTemplate(CTID, 'demo', 'test'));
		await pve.configure(CTID, { cores: 1, memory: 1024, swap: 512, net0: `name=eth0,bridge=nat,ip=${IP}/24,gw=10.10.10.1`, onboot: 1, protection: 0, tags: 'forge' });
		expect(world().guests.get(CTID)?.config.protection).toBe(0);
		await finish(pve, await pve.destroy(CTID));
		expect(world().guests.has(CTID)).toBe(false);
	});

	it('destroy retire d’abord la protection restée active (clone créé avant le correctif)', async () => {
		const pve = gateway();
		await finish(pve, await pve.cloneTemplate(CTID, 'demo', 'test'));
		await finish(pve, await pve.destroy(CTID));
		expect(world().guests.has(CTID)).toBe(false);
	});

	it('destroy reste refusé hors du pool, même protégé', async () => {
		const pve = gateway();
		await expect(pve.destroy(402)).rejects.toThrow(/production protégé/);
		expect(world().guests.has(402)).toBe(true);
	});
});

/** Passerelle NPM réelle (garde hors DRY_RUN) : seul le proxy host « notes » appartient à Forge. */
function proxyGateway() {
	const apis = createFakeApis();
	const settings = new SettingsService(memoryStore(), { encrypt: (s) => s, decrypt: (s) => s });
	const guard = new WriteGuard(() => false, (s) => s);
	const notes = world().npmHosts.find((h) => h.domainNames.includes('notes.bastiengrnt.fr'));
	const ownership = { owned: () => [{ type: 'npm_proxy_host' as const, externalId: String(notes?.id), projectId: 1 }] };
	const projects = { forgeIps: () => ['10.10.10.60'], forgeRepos: () => [] };
	return { npm: new ProxyGateway({ apis: () => apis, guard, settings, ownership, projects }), notes };
}

describe('ProxyGateway — changement de port', () => {
	beforeEach(() => resetWorld());

	it('redirige un proxy host Forge vers le nouveau port, sans toucher au certificat', async () => {
		const { npm, notes } = proxyGateway();
		const cert = notes?.certificateId;
		await npm.repointProxyHost(notes?.id ?? 0, '10.10.10.60', 8080);
		const after = world().npmHosts.find((h) => h.id === notes?.id);
		expect(after).toMatchObject({ forwardHost: '10.10.10.60', forwardPort: 8080, certificateId: cert });
	});

	it('refuse un proxy host de la prod, même vers le même CT', async () => {
		const { npm } = proxyGateway();
		const wallet = world().npmHosts.find((h) => h.domainNames.includes('wallet.bastiengrnt.fr'));
		await expect(npm.repointProxyHost(wallet?.id ?? 0, '10.10.10.42', 4000)).rejects.toThrow(/pas été créé par Forge/);
		expect(world().npmHosts.find((h) => h.id === wallet?.id)?.forwardPort).toBe(3000);
	});
});

describe('DbCommand', () => {
	const loc = { repoDir: '/home/github/actions-runner/_work/app/app', workdir: '.', composeFile: 'docker-compose.prod.yml', service: 'db', kind: 'postgres' as const, slug: 'app' };

	it('la requête lue sur le tube atteint docker compose DANS le dossier du dépôt', () => {
		const cmd = DbCommand.query(loc, 'select 1', true).toString();
		expect(cmd).toContain(`| base64 -d | (cd '/home/github/actions-runner/_work/app/app/.' && docker compose -f 'docker-compose.prod.yml' exec -T 'db'`);
	});

	it('restauration : même regroupement après gunzip', () => {
		expect(DbCommand.restore(loc, '20261014-120000-manual.sql.gz').toString()).toMatch(/gunzip -c '[^']+' \| \(cd '/);
	});

	it('téléchargement : slug validé comme pour les autres commandes', () => {
		expect(() => DbCommand.download({ slug: '../etc' }, '20261014-120000-manual.sql.gz', 1024)).toThrow(/Projet invalide/);
		expect(() => DbCommand.download({ slug: 'app' }, '20261014-120000-manual.sql.gz', 1024)).not.toThrow();
	});
});

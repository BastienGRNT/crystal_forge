import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeApis } from '$server/infrastructure/mock/fake-apis';
import { resetWorld, world } from '$server/infrastructure/mock/world';
import { DbCommand, ProxmoxGateway } from './gateways';
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

describe('DbCommand', () => {
	const loc = { repoDir: '/home/github/actions-runner/_work/app/app', workdir: '.', composeFile: 'docker-compose.prod.yml', service: 'db', kind: 'postgres' as const, slug: 'app' };

	it('la requête lue sur le tube atteint docker compose DANS le dossier du dépôt', () => {
		const cmd = DbCommand.query(loc, 'select 1', true).toString();
		expect(cmd).toContain(`| base64 -d | (cd '/home/github/actions-runner/_work/app/app/.' && docker compose -f 'docker-compose.prod.yml' exec -T 'db'`);
	});

	it('restauration : même regroupement après gunzip', () => {
		expect(DbCommand.restore(loc, '20261014-120000-manual.sql.gz').toString()).toMatch(/gunzip -c '[^']+' \| \(cd '/);
	});
});

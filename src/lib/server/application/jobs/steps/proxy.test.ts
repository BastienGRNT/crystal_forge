import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Forge complet en mode simulé, sur une base jetable.
vi.mock('$env/dynamic/private', () => {
	const dir = mkdtempSync(join(tmpdir(), 'forge-proxy-'));
	return { env: { FORGE_MODE: 'mock', DATABASE_PATH: join(dir, 'forge.db'), FORGE_UPDATES_DIR: join(dir, 'updates') } };
});

const { forge } = await import('$server/container');
const { world } = await import('$server/infrastructure/mock/world');

async function finished(jobId: number) {
	const f = forge();
	for (let i = 0; i < 1200; i++) {
		const job = f.repos.jobs.get(jobId);
		if (job && !['queued', 'running'].includes(job.status)) return job;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error('job trop long');
}

describe('Proxy NPM supprimé à la main', { timeout: 90_000 }, () => {
	it('« Recréer le proxy » le recrée avec le même certificat, sans nouvelle demande Let’s Encrypt', async () => {
		const f = forge();
		const p = f.projects.get('crystal-notes');
		const domain = f.repos.domains.byProject(p.id)[0];
		const before = world().npmHosts.find((h) => h.domainNames.includes('notes.bastiengrnt.fr'));
		expect(before).toBeDefined();
		const certs = world().npmCerts.length;

		// Suppression dans l'interface de NPM : Forge ne l'a pas vue.
		world().npmHosts = world().npmHosts.filter((h) => h.id !== before?.id);
		expect((await f.projects.domainsView(p)).domains[0]?.proxyHostId).toBeNull();

		const job = await finished(f.projects.repairDomain(p, domain?.id ?? 0));
		expect(job.status).toBe('succeeded');
		const after = world().npmHosts.find((h) => h.domainNames.includes('notes.bastiengrnt.fr'));
		expect(after).toMatchObject({ forwardHost: '10.10.10.60', forwardPort: 3000, certificateId: before?.certificateId });
		expect(after?.id).not.toBe(before?.id);
		expect(world().npmCerts.length).toBe(certs);
		expect(f.repos.resources.findActive('npm_proxy_host', String(before?.id))).toBeUndefined();
		expect(f.repos.resources.findActive('npm_proxy_host', String(after?.id))).toBeDefined();
	});

	it('retirer un domaine dont le proxy host a déjà disparu ne bloque pas', async () => {
		const f = forge();
		const p = f.projects.get('crystal-notes');
		await f.projects.addDomain(p, { subdomain: 'notes2', zone: 'bastiengrnt.fr', managed: true }).then(finished);
		const d = f.repos.domains.byProject(p.id).find((x) => x.fqdn === 'notes2.bastiengrnt.fr');
		expect(d?.status).toBe('active');
		world().npmHosts = world().npmHosts.filter((h) => !h.domainNames.includes('notes2.bastiengrnt.fr'));
		const job = await finished(f.projects.removeDomain(p, d?.id ?? 0));
		expect(job.status).toBe('succeeded');
		expect(f.repos.domains.get(d?.id ?? 0)).toBeUndefined();
	});
});

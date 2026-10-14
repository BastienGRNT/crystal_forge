import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportPublicKey, importProvisioning } from './provisioning';
import { SettingsService, type SettingsStore } from './settings';

function settings() {
	const rows = new Map<string, { value: string; isSecret: boolean }>();
	const store: SettingsStore = {
		all: () => [...rows.entries()].map(([key, r]) => ({ key, ...r })),
		get: (key) => rows.get(key),
		set: (key, value, isSecret) => void rows.set(key, { value, isSecret }),
		delete: (key) => void rows.delete(key)
	};
	return new SettingsService(store, { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.slice(4) });
}

describe('provision.json (infra/02 → Forge)', () => {
	it('importe uniquement les réglages Proxmox autorisés, puis supprime le fichier', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'forge-prov-'));
		const s = settings();
		await writeFile(
			join(dir, 'provision.json'),
			JSON.stringify({ 'proxmox.tokenSecret': 'abcd-1234', 'proxmox.caCert': '-----BEGIN CERTIFICATE-----', 'runtime.dryRun': 'false', 'github.token': 'ghp_x' })
		);
		expect(await importProvisioning(dir, s)).toEqual(['proxmox.tokenSecret', 'proxmox.caCert']);
		expect(s.get('proxmox.tokenSecret')).toBe('abcd-1234');
		expect(s.get('runtime.dryRun')).toBe('');
		expect(s.has('github.token')).toBe(false);
		expect(existsSync(join(dir, 'provision.json'))).toBe(false);
		expect(await importProvisioning(dir, s)).toBeNull();
	});

	it('publie la clé publique pour bootstrap.sh', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'forge-pub-'));
		await exportPublicKey(dir, 'ssh-ed25519 AAAA forge');
		expect(await readFile(join(dir, 'forge.pub'), 'utf8')).toBe('ssh-ed25519 AAAA forge\n');
	});
});

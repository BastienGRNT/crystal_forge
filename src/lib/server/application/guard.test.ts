import { describe, expect, it, vi } from 'vitest';
import { executionScope, WriteGuard } from './guard';
import { Redactor } from './redactor';
import { SafetyViolation } from '$lib/domain/errors';

function scope(dryRun: boolean) {
	const logs: { level: string; message: string }[] = [];
	return { logs, value: { jobId: 1, stepKey: 'ct', dryRun, log: (level: string, message: string) => logs.push({ level, message }) } };
}

describe('WriteGuard', () => {
	it("en DRY_RUN : journalise et simule, n'exécute jamais", async () => {
		const guard = new WriteGuard(() => false, (s) => s);
		const execute = vi.fn(async () => 'réel');
		const s = scope(true);
		const res = await executionScope.run(s.value as never, () =>
			guard.run({ system: 'proxmox', action: 'clone', summary: 'Cloner 900 → 500', execute, simulate: () => 'dry-run:upid' })
		);
		expect(res).toBe('dry-run:upid');
		expect(execute).not.toHaveBeenCalled();
		expect(s.logs[0]).toMatchObject({ level: 'dry' });
		expect(s.logs[0]?.message).toContain('[DRY-RUN] Proxmox · Cloner 900 → 500');
	});

	it('hors DRY_RUN : exécute', async () => {
		const guard = new WriteGuard(() => false, (s) => s);
		const s = scope(false);
		const res = await executionScope.run(s.value as never, () =>
			guard.run({ system: 'npm', action: 'create', summary: 'x', execute: async () => 42, simulate: () => 0 })
		);
		expect(res).toBe(42);
	});

	it("le DRY_RUN global s'applique hors job", async () => {
		const guard = new WriteGuard(() => true, (s) => s);
		const execute = vi.fn(async () => 1);
		await guard.run({ system: 'ovh', action: 'create', summary: 'x', execute, simulate: () => 0 });
		expect(execute).not.toHaveBeenCalled();
	});

	it('une règle de sécurité refuse AVANT toute exécution, même hors DRY_RUN', async () => {
		const guard = new WriteGuard(() => false, (s) => s);
		const execute = vi.fn(async () => 1);
		const simulate = vi.fn(() => 0);
		const s = scope(false);
		await expect(
			executionScope.run(s.value as never, () =>
				guard.run({
					system: 'proxmox',
					action: 'destroy',
					summary: 'Supprimer 402',
					check: () => {
						throw new SafetyViolation('ct.protected', 'CT de prod');
					},
					execute,
					simulate
				})
			)
		).rejects.toBeInstanceOf(SafetyViolation);
		expect(execute).not.toHaveBeenCalled();
		expect(simulate).not.toHaveBeenCalled();
		expect(s.logs[0]?.level).toBe('error');
		expect(guard.recentAudit()[0]?.outcome).toBe('refused');
	});

	it('masque les secrets dans les logs', async () => {
		const r = new Redactor();
		r.add('super-secret-token-123');
		const guard = new WriteGuard(() => true, (x) => r.redact(x));
		const s = scope(true);
		await executionScope.run(s.value as never, () =>
			guard.run({ system: 'ssh', action: 'exec', summary: './config.sh --token super-secret-token-123', execute: async () => 0, simulate: () => 0 })
		);
		expect(s.logs[0]?.message).not.toContain('super-secret-token-123');
	});
});

describe('Redactor', () => {
	it('masque valeurs connues, jetons GitHub et clés privées', () => {
		const r = new Redactor();
		r.add('DB_PASSWORD_VALUE', 'ab'); // trop court : ignoré
		const out = r.redact(
			'pwd=DB_PASSWORD_VALUE tok=ghp_abcdefghijklmnopqrstuvwxyz0123 --token AAAABBBBCCCC ab\n-----BEGIN OPENSSH PRIVATE KEY-----\nxyz\n-----END OPENSSH PRIVATE KEY-----'
		);
		expect(out).not.toContain('DB_PASSWORD_VALUE');
		expect(out).not.toContain('ghp_');
		expect(out).not.toContain('AAAABBBBCCCC');
		expect(out).toContain('--token ••••••');
		expect(out).not.toContain('xyz');
		expect(out).toContain(' ab');
	});
});

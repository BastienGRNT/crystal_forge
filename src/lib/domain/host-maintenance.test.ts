import { describe, expect, it } from 'vitest';
import { assertSafeBackupJob, assertSafeCtRestore, assertSafeCriticalCtTune, backupJobChanges, criticalCtPlan, desiredBackupJobs } from './host-maintenance';

const ctx = { pool: 'forge', criticalCtids: [100, 150] };

describe('garde des jobs de sauvegarde', () => {
	it('accepte les jobs voulus', () => {
		for (const j of desiredBackupJobs(ctx)) expect(() => assertSafeBackupJob({ ...j }, ctx)).not.toThrow();
	});
	it('refuse un autre job, stockage, pool, CT ou option', () => {
		const [crit, proj] = desiredBackupJobs(ctx).map((j) => ({ ...j }) as Record<string, unknown>);
		expect(() => assertSafeBackupJob({ ...crit, id: 'backup-1234' }, ctx)).toThrow();
		expect(() => assertSafeBackupJob({ ...crit, storage: 'local' }, ctx)).toThrow();
		expect(() => assertSafeBackupJob({ ...proj, pool: 'autre' }, ctx)).toThrow();
		expect(() => assertSafeBackupJob({ ...crit, vmid: '100,101' }, ctx)).toThrow();
		expect(() => assertSafeBackupJob({ ...crit, tmpdir: '/' }, ctx)).toThrow();
		expect(() => assertSafeBackupJob({ ...crit, pool: 'forge' }, ctx)).toThrow();
	});
	it('ne recrée pas un job identique, met à jour un job divergent', () => {
		const desired = desiredBackupJobs(ctx);
		const current = [
			{ id: 'forge-prod-daily', enabled: true, schedule: '03:30', vmid: '150,100', pool: null, storage: 'forge-backups' },
			{ id: 'forge-projects-daily', enabled: true, schedule: '04:00', vmid: null, pool: 'forge', storage: 'local' }
		];
		expect(backupJobChanges(current, desired)).toEqual([{ job: desired[1], exists: true }]);
	});
});

describe('garde des CT critiques', () => {
	const base = { vmid: 100, criticalCtids: [100, 150], currentMemoryMb: 512 };
	it('autorise RAM à la hausse et poids CPU', () => {
		expect(() => assertSafeCriticalCtTune({ ...base, config: { memory: 1024, cpuunits: 400 } })).not.toThrow();
	});
	it('refuse baisse, dépassement, autre clé ou autre CT', () => {
		expect(() => assertSafeCriticalCtTune({ ...base, config: { memory: 256 } })).toThrow();
		expect(() => assertSafeCriticalCtTune({ ...base, config: { memory: 8192 } })).toThrow();
		expect(() => assertSafeCriticalCtTune({ ...base, config: { cores: 4 } })).toThrow();
		expect(() => assertSafeCriticalCtTune({ ...base, vmid: 501, config: { cpuunits: 400 } })).toThrow();
	});
	it("n'augmente la RAM que si le CT étouffe et que l'hôte a la place", () => {
		expect(criticalCtPlan({ memoryMb: 512, usedMb: 500, cpuunits: 400, hostAvailableMb: 8000 })).toEqual({ memory: 1024 });
		expect(criticalCtPlan({ memoryMb: 512, usedMb: 200, cpuunits: 400, hostAvailableMb: 8000 })).toEqual({});
		expect(criticalCtPlan({ memoryMb: 512, usedMb: 500, cpuunits: 400, hostAvailableMb: 2200 })).toEqual({});
	});
});

describe('assertSafeCtRestore', () => {
	const base = { vmid: 510, volid: 'forge-backup:backup/vzdump-lxc-510-2026_11_16-04_00_01.tar.zst', criticalCtids: [100, 150], ownedByForge: true };
	it('accepte la sauvegarde du même CT Forge', () => {
		expect(() => assertSafeCtRestore(base)).not.toThrow();
	});
	it('refuse un CT critique, un CT hors Forge, la sauvegarde d’un autre CT ou un volid bizarre', () => {
		expect(() => assertSafeCtRestore({ ...base, vmid: 100, volid: 'forge-backup:backup/vzdump-lxc-100-2026_11_16-04_00_01.tar.zst' })).toThrow();
		expect(() => assertSafeCtRestore({ ...base, ownedByForge: false })).toThrow();
		expect(() => assertSafeCtRestore({ ...base, volid: 'forge-backup:backup/vzdump-lxc-511-2026_11_16-04_00_01.tar.zst' })).toThrow();
		expect(() => assertSafeCtRestore({ ...base, volid: 'forge-backup:backup/../vzdump-lxc-510-x.tar.zst' })).toThrow();
		expect(() => assertSafeCtRestore({ ...base, volid: 'local:iso/vzdump-lxc-510-2026_11_16.tar.zst' })).toThrow();
	});
});

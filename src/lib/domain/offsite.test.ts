import { describe, expect, it } from 'vitest';
import { assertOffsitePath, assertSnapshotId, parseSnapshots, projectDbPath, resticRepository } from './offsite';

describe('sauvegardes hors serveur', () => {
	it('construit le dépôt restic et refuse une adresse douteuse', () => {
		expect(resticRepository({ endpoint: 'https://abc123.r2.cloudflarestorage.com', bucket: 'forge-backups' })).toBe('s3:https://abc123.r2.cloudflarestorage.com/forge-backups/forge');
		expect(() => resticRepository({ endpoint: 'http://abc.r2.cloudflarestorage.com', bucket: 'b-1' })).toThrow();
		expect(() => resticRepository({ endpoint: 'https://abc.r2.cloudflarestorage.com/x', bucket: 'bkt' })).toThrow();
		expect(() => resticRepository({ endpoint: 'https://abc.r2.cloudflarestorage.com', bucket: 'Bad_Bucket' })).toThrow();
	});
	it("n'écrit que la base de Forge et les dumps de projets", () => {
		expect(() => assertOffsitePath('/forge.db')).not.toThrow();
		expect(() => assertOffsitePath(projectDbPath('mon-app'))).not.toThrow();
		expect(() => assertOffsitePath('/etc/passwd')).toThrow();
		expect(() => projectDbPath('../x')).toThrow();
		expect(() => assertSnapshotId('abcdef12')).not.toThrow();
		expect(() => assertSnapshotId('latest; rm')).toThrow();
	});
	it('lit les instantanés, du plus récent au plus ancien', () => {
		const snaps = parseSnapshots(
			JSON.stringify([
				{ short_id: 'aaaaaaaa', time: '2026-11-01T03:00:00Z', paths: ['/forge.db'], tags: ['forge'] },
				{ short_id: 'bbbbbbbb', time: '2026-11-02T03:00:00Z', paths: ['/project-a.sql.gz'], tags: ['project:a'] },
				{ short_id: 'pas-hex!', time: '2026-11-02T03:00:00Z', paths: [] }
			])
		);
		expect(snaps.map((s) => s.id)).toEqual(['bbbbbbbb', 'aaaaaaaa']);
	});
});

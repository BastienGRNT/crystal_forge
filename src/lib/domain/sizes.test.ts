import { describe, expect, it } from 'vitest';
import { assessHostRam, committedMemoryMb, hostMemoryInUse, SIZES } from './sizes';

const MiB = 1024 ** 2;

describe('RAM de l’hôte', () => {
	it('déduit le cache ZFS (ARC) de la RAM utilisée', () => {
		expect(hostMemoryInUse({ used: 11_241 * MiB, arc: 7_640 * MiB })).toBe(3_601 * MiB);
		expect(hostMemoryInUse({ used: 4_000 * MiB, arc: 0 })).toBe(4_000 * MiB);
		expect(hostMemoryInUse({ used: 1_000 * MiB, arc: 2_000 * MiB })).toBe(0);
	});

	it('un CT L passe sans confirmation quand l’essentiel de « used » est du cache ZFS', () => {
		const total = 15_678;
		// Cas réel du 15/10/2026 : 11,2 Go « utilisés » dont 7,6 Go d'ARC.
		expect(assessHostRam(total, 11_241, SIZES.L).level).toBe('tight');
		expect(assessHostRam(total, hostMemoryInUse({ used: 11_241 * MiB, arc: 7_640 * MiB }) / MiB, SIZES.L).level).toBe('ok');
	});
});

describe('RAM promise aux CT (anti-cascade)', () => {
	it('demande confirmation au-delà de 125 % de RAM promise, même avec de la RAM libre', () => {
		const r = assessHostRam(15_600, 4_000, SIZES.M, 18_000);
		expect(r.overcommitted).toBe(true);
		expect(r.level).toBe('tight');
	});
	it('reste ok sous le seuil, et ne masque jamais un manque réel de RAM', () => {
		expect(assessHostRam(15_600, 4_000, SIZES.M, 10_000).level).toBe('ok');
		expect(assessHostRam(15_600, 15_000, SIZES.M, 30_000).level).toBe('insufficient');
	});
	it('compte seulement les CT démarrés hors templates', () => {
		const g = (status: string, template: boolean, mb: number) => ({ status, template, maxmem: mb * MiB });
		expect(committedMemoryMb([g('running', false, 2048), g('stopped', false, 4096), g('running', true, 1024)])).toBe(2048);
	});
});

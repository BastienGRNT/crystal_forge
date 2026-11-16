import { describe, expect, it } from 'vitest';
import { parseBuildCacheUsage, parseDockerSize, pruneBuildCacheCommand } from './build-cache';
import { assertSafeCommand } from './safety-policy';

describe('cache de build', () => {
	it('lit la sortie de docker system df et df', () => {
		const u = parseBuildCacheUsage('Images\t1.2GB\nContainers\t2.1MB\nLocal Volumes\t310MB\nBuild Cache\t10.25GB\n4000000000 10737418240\n');
		expect(u.buildCacheBytes).toBe(10_250_000_000);
		expect(u.imagesBytes).toBe(1_200_000_000);
		expect(u.diskTotalBytes).toBe(10_737_418_240);
		expect(parseDockerSize('0B')).toBe(0);
	});
	it('ne touche jamais aux volumes ni aux conteneurs', () => {
		for (const all of [true, false]) {
			const cmd = pruneBuildCacheCommand(all);
			expect(() => assertSafeCommand(cmd)).not.toThrow();
			expect(cmd).not.toMatch(/volume|system prune|container|image prune|compose down/);
		}
	});
});

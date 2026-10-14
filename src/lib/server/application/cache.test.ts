import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from './cache';

describe('TtlCache', () => {
	it('partage une seule requête entre appels simultanés, puis sert la valeur pendant le TTL', async () => {
		const cache = new TtlCache();
		const load = vi.fn(async () => 42);
		const [a, b] = await Promise.all([cache.get('k', 1000, load), cache.get('k', 1000, load)]);
		expect([a, b]).toEqual([42, 42]);
		expect(await cache.get('k', 1000, load)).toBe(42);
		expect(load).toHaveBeenCalledTimes(1);
	});

	it('relit après expiration', async () => {
		vi.useFakeTimers();
		const cache = new TtlCache();
		const load = vi.fn(async () => Date.now());
		await cache.get('k', 1000, load);
		vi.advanceTimersByTime(1500);
		await cache.get('k', 1000, load);
		expect(load).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});

	it("ne met jamais une erreur en cache", async () => {
		const cache = new TtlCache();
		const load = vi.fn().mockRejectedValueOnce(new Error('panne')).mockResolvedValueOnce('ok');
		await expect(cache.get('k', 1000, load)).rejects.toThrow('panne');
		expect(await cache.get('k', 1000, load)).toBe('ok');
	});

	it("clear() : une lecture lancée avant l'écriture ne remplit pas le cache", async () => {
		const cache = new TtlCache();
		let release!: (v: string) => void;
		const slow = cache.get('k', 10_000, () => new Promise<string>((r) => (release = r)));
		cache.clear();
		release('avant');
		expect(await slow).toBe('avant');
		expect(await cache.get('k', 10_000, async () => 'après')).toBe('après');
	});
});

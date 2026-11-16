import { describe, expect, it } from 'vitest';
import { assertSafeVolumeMove, rootfsStorage } from './storage';

describe('stockage des CT', () => {
	it('lit le stockage du rootfs', () => {
		expect(rootfsStorage('local:500/vm-500-disk-0.raw,size=8G')).toBe('local');
		expect(rootfsStorage('forge-ct:subvol-500-disk-0,size=8G')).toBe('forge-ct');
		expect(rootfsStorage('')).toBeNull();
	});
	it('ne déplace que le rootfs, et seulement vers forge-ct', () => {
		expect(() => assertSafeVolumeMove('rootfs', 'forge-ct')).not.toThrow();
		expect(() => assertSafeVolumeMove('rootfs', 'local')).toThrow();
		expect(() => assertSafeVolumeMove('mp0', 'forge-ct')).toThrow();
	});
});

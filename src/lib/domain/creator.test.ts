import { describe, expect, it } from 'vitest';
import { creatorQuotaErrors, parseZones, zoneAllowed, type CreatorLimits } from './creator';

const limits: CreatorLimits = { canCreate: true, maxProjects: 2, maxRamMb: 2048, allowedZones: ['exemple.fr'], githubLogin: 'alice' };

describe('création de projets par un collaborateur', () => {
	it('lit les zones et ne permet que celles-ci (et leurs sous-domaines)', () => {
		expect(parseZones('Exemple.fr, dev.autre.com ; pas-une-zone')).toEqual(['exemple.fr', 'dev.autre.com']);
		expect(zoneAllowed('exemple.fr', ['exemple.fr'])).toBe(true);
		expect(zoneAllowed('app.exemple.fr', ['exemple.fr'])).toBe(true);
		expect(zoneAllowed('fauxexemple.fr', ['exemple.fr'])).toBe(false);
		expect(zoneAllowed('exemple.fr', [])).toBe(false);
	});
	it('refuse sans droit, au-delà des quotas, hors zone ou sans compte GitHub', () => {
		expect(creatorQuotaErrors(limits, [], { memoryMb: 1024, zones: ['exemple.fr'] })).toEqual([]);
		expect(creatorQuotaErrors({ ...limits, canCreate: false }, [], { memoryMb: 512, zones: [] })).toHaveLength(1);
		expect(creatorQuotaErrors(limits, [{ memoryMb: 512 }, { memoryMb: 512 }], { memoryMb: 512, zones: [] }).join()).toMatch(/Quota atteint/);
		expect(creatorQuotaErrors(limits, [{ memoryMb: 1536 }], { memoryMb: 1024, zones: [] }).join()).toMatch(/RAM/);
		expect(creatorQuotaErrors(limits, [], { memoryMb: 512, zones: ['autre.com'] }).join()).toMatch(/non autorisée/);
		expect(creatorQuotaErrors({ ...limits, githubLogin: null }, [], { memoryMb: 512, zones: [] }).join()).toMatch(/GitHub/);
	});
});

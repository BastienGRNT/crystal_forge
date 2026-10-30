import { describe, expect, it } from 'vitest';
import { servesDomain } from './domain-name';

describe('servesDomain', () => {
	it('compare les noms sans tenir compte de la casse', () => {
		expect(servesDomain(['Notes.Example.com'], 'notes.example.com')).toBe(true);
		expect(servesDomain(['notes.example.com'], 'NOTES.example.com')).toBe(true);
		expect(servesDomain(['wallet.example.com'], 'notes.example.com')).toBe(false);
	});
});

describe('wildcard', () => {
	it('accepte * en premier label seulement', async () => {
		const { isValidSubdomain, isWildcard, wildcardProbe, buildFqdn } = await import('./domain-name');
		expect(isValidSubdomain('*')).toBe(true);
		expect(isValidSubdomain('*.site')).toBe(true);
		expect(isValidSubdomain('site.*')).toBe(false);
		expect(isValidSubdomain('a*b')).toBe(false);
		expect(isWildcard(buildFqdn('*.site', 'exemple.fr'))).toBe(true);
		expect(wildcardProbe('*.site.exemple.fr')).toBe('forge-check.site.exemple.fr');
		expect(wildcardProbe('app.exemple.fr')).toBe('app.exemple.fr');
	});
});

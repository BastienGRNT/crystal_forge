import { describe, expect, it } from 'vitest';
import { servesDomain } from './domain-name';

describe('servesDomain', () => {
	it('compare les noms sans tenir compte de la casse', () => {
		expect(servesDomain(['Notes.Example.com'], 'notes.example.com')).toBe(true);
		expect(servesDomain(['notes.example.com'], 'NOTES.example.com')).toBe(true);
		expect(servesDomain(['wallet.example.com'], 'notes.example.com')).toBe(false);
	});
});

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { dangerousOvhRules, ovhCreateTokenUrl, ovhSignature } from './ovh-signature';

describe('ovhSignature', () => {
	it('suit la formule officielle $1$ + sha1(AS+CK+METHOD+URL+BODY+TS)', () => {
		const sig = ovhSignature({
			appSecret: 'AS',
			consumerKey: 'CK',
			method: 'get',
			url: 'https://eu.api.ovh.com/1.0/domain/zone',
			body: '',
			timestamp: 1700000000
		});
		const expected = '$1$' + createHash('sha1').update('AS+CK+GET+https://eu.api.ovh.com/1.0/domain/zone++1700000000').digest('hex');
		expect(sig).toBe(expected);
	});

	it('vecteur de référence fixe (non-régression)', () => {
		const sig = ovhSignature({
			appSecret: 'EXEgWIz07P0HYwtQDs7cNIqCiQaWSuHF',
			consumerKey: 'MtSwSrPpNjqfVSmJhLbPyr2i45lSwPU1',
			method: 'POST',
			url: 'https://eu.api.ovh.com/1.0/domain/zone/bastiengrnt.fr/record',
			body: '{"fieldType":"A","subDomain":"test","target":"51.68.180.212","ttl":300}',
			timestamp: 1760430000
		});
		expect(sig).toMatch(/^\$1\$[0-9a-f]{40}$/);
		expect(sig).toBe(
			'$1$' +
				createHash('sha1')
					.update(
						'EXEgWIz07P0HYwtQDs7cNIqCiQaWSuHF+MtSwSrPpNjqfVSmJhLbPyr2i45lSwPU1+POST+https://eu.api.ovh.com/1.0/domain/zone/bastiengrnt.fr/record+{"fieldType":"A","subDomain":"test","target":"51.68.180.212","ttl":300}+1760430000'
					)
					.digest('hex')
		);
	});

	it('la signature change si un seul élément change', () => {
		const base = { appSecret: 'a', consumerKey: 'b', method: 'GET', url: 'u', body: '', timestamp: 1 };
		const s = ovhSignature(base);
		expect(ovhSignature({ ...base, timestamp: 2 })).not.toBe(s);
		expect(ovhSignature({ ...base, method: 'POST' })).not.toBe(s);
		expect(ovhSignature({ ...base, body: '{}' })).not.toBe(s);
	});
});

describe('règles OVH', () => {
	it('signale les règles trop larges', () => {
		const res = dangerousOvhRules([
			{ method: 'POST', path: '/domain/zone/*' },
			{ method: 'GET', path: '/domain/zone/*' },
			{ method: 'POST', path: '/domain/zone/bastiengrnt.fr/record' },
			{ method: 'GET', path: '/*' }
		]);
		expect(res.map((r) => r.rule.path)).toEqual(['/domain/zone/*', '/*']);
	});
	it('génère un lien createToken par zone sans /reset', () => {
		const url = ovhCreateTokenUrl('https://eu.api.ovh.com/1.0', ['bastiengrnt.fr'], true);
		expect(url.startsWith('https://eu.api.ovh.com/createToken/?')).toBe(true);
		expect(url).toContain('POST=/domain/zone/bastiengrnt.fr/record&');
		expect(url).toContain('DELETE=/domain/zone/bastiengrnt.fr/record/*');
		expect(url).not.toContain('POST=/domain/zone/*');
	});
});

import { describe, expect, it } from 'vitest';
import { hasEnvErrors, maskValue, parseEnv } from './env-file';

describe('parseEnv', () => {
	it('lit les paires simples, ignore commentaires et lignes vides', () => {
		const p = parseEnv('# config\nDB_USER=crystal\n\nDB_PASSWORD=s3cr3t # commentaire\n');
		expect(p.entries.map((e) => [e.key, e.value])).toEqual([
			['DB_USER', 'crystal'],
			['DB_PASSWORD', 's3cr3t']
		]);
		expect(hasEnvErrors(p)).toBe(false);
	});

	it('gère export, guillemets simples, doubles et échappements', () => {
		const p = parseEnv(`export A=1\nB='a # pas un commentaire'\nC="ligne1\\nligne2"\nD="dit \\"oui\\""`);
		const map = Object.fromEntries(p.entries.map((e) => [e.key, e.value]));
		expect(map).toEqual({ A: '1', B: 'a # pas un commentaire', C: 'ligne1\nligne2', D: 'dit "oui"' });
	});

	it('gère les valeurs multi-lignes (clés PEM)', () => {
		const p = parseEnv('KEY="-----BEGIN-----\nabc\n-----END-----"\nNEXT=1');
		expect(p.entries[0]?.value).toBe('-----BEGIN-----\nabc\n-----END-----');
		expect(p.entries[1]).toMatchObject({ key: 'NEXT', value: '1', line: 4 });
	});

	it('signale les erreurs et les doublons', () => {
		const p = parseEnv('PAS_DE_EGAL\n1ABC=x\nA=1\nA=2\nB="non fermé');
		expect(p.issues.filter((i) => i.level === 'error')).toHaveLength(3);
		expect(p.issues.some((i) => i.level === 'warning' && i.message.includes('déjà défini'))).toBe(true);
		expect(p.entries.find((e) => e.key === 'A')?.value).toBe('2');
	});

	it('normalise CRLF et ajoute le saut de ligne final', () => {
		const p = parseEnv('A=1\r\nB=2');
		expect(p.normalized).toBe('A=1\nB=2\n');
	});

	it('refuse un fichier de plus de 48 Ko', () => {
		const p = parseEnv(`BIG=${'x'.repeat(50 * 1024)}`);
		expect(hasEnvErrors(p)).toBe(true);
	});

	it('ne révèle jamais la valeur dans le masque', () => {
		expect(maskValue('hunter2')).not.toContain('hunter2');
		expect(maskValue('')).toBe('(vide)');
	});
});

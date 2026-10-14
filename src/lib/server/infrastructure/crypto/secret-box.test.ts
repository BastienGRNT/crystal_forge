import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox } from './secret-box';
import { generateBoxKeyPair, openSealed, sealForGithub } from './sealed-box';

describe('SecretBox (AES-256-GCM)', () => {
	const box = new SecretBox(randomBytes(32));

	it('chiffre et déchiffre', () => {
		const enc = box.encrypt('DB_PASSWORD=s3cr3t\n');
		expect(enc.startsWith('v1:')).toBe(true);
		expect(enc).not.toContain('s3cr3t');
		expect(box.decrypt(enc)).toBe('DB_PASSWORD=s3cr3t\n');
	});

	it('produit un chiffré différent à chaque fois (IV aléatoire)', () => {
		expect(box.encrypt('x')).not.toBe(box.encrypt('x'));
	});

	it('détecte toute altération', () => {
		const enc = box.encrypt('valeur');
		const raw = Buffer.from(enc.slice(3), 'base64');
		raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
		expect(() => box.decrypt('v1:' + raw.toString('base64'))).toThrow();
	});

	it('lie le chiffré à son contexte (AAD)', () => {
		const enc = box.encrypt('token', 'settings:github.token');
		expect(box.decrypt(enc, 'settings:github.token')).toBe('token');
		expect(() => box.decrypt(enc, 'settings:npm.secret')).toThrow();
	});

	it('refuse une autre clé', () => {
		const other = new SecretBox(randomBytes(32));
		expect(() => other.decrypt(box.encrypt('x'))).toThrow();
	});
});

describe('sealed box GitHub', () => {
	it('le secret scellé ne peut être ouvert qu’avec la clé privée du dépôt', async () => {
		const kp = await generateBoxKeyPair();
		const sealed = await sealForGithub(kp.publicKey, 'A=1\nB=2\n');
		expect(await openSealed(sealed, kp.publicKey, kp.privateKey)).toBe('A=1\nB=2\n');
	});
});

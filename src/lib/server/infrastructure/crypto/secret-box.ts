/**
 * Chiffrement au repos : AES-256-GCM, clé maître FORGE_MASTER_KEY.
 * Format : "v1:" + base64(iv[12] ‖ tag[16] ‖ ciphertext).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'v1:';

export class SecretBox {
	readonly #key: Buffer;

	constructor(key: Buffer) {
		if (key.length !== 32) throw new Error('La clé AES-256 doit faire 32 octets');
		this.#key = key;
	}

	encrypt(plaintext: string, aad?: string): string {
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
		if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
		const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
		const tag = cipher.getAuthTag();
		return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
	}

	decrypt(payload: string, aad?: string): string {
		if (!payload.startsWith(PREFIX)) throw new Error('Format chiffré inconnu');
		const raw = Buffer.from(payload.slice(PREFIX.length), 'base64');
		if (raw.length < 28) throw new Error('Données chiffrées tronquées');
		const iv = raw.subarray(0, 12);
		const tag = raw.subarray(12, 28);
		const ct = raw.subarray(28);
		const decipher = createDecipheriv('aes-256-gcm', this.#key, iv);
		if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
	}
}

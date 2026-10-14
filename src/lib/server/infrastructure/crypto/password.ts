import { hash, verify } from '@node-rs/argon2';

// Paramètres argon2id recommandés par l'OWASP (19 Mio, 2 passes).
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
	return hash(password, OPTIONS);
}

export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
	try {
		return await verify(hashed, password);
	} catch {
		return false;
	}
}

export function validatePasswordStrength(password: string): string | null {
	if (password.length < 12) return 'Le mot de passe doit faire au moins 12 caractères.';
	if (/^(.)\1+$/.test(password)) return 'Mot de passe trop simple.';
	return null;
}

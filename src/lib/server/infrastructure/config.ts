/**
 * Configuration lue depuis l'environnement (au démarrage uniquement).
 * Tout ce qui est modifiable (tokens, plages…) est dans la table settings.
 */
import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';

export type ForgeMode = 'live' | 'mock';

export interface AppConfig {
	/** live : vraies API. mock : infrastructure simulée en mémoire (démo / dev). */
	mode: ForgeMode;
	/** Valeur initiale du DRY_RUN (true par défaut : il faut écrire DRY_RUN=false pour écrire). */
	dryRunDefault: boolean;
	databasePath: string;
	masterKey: Buffer;
	masterKeyIsDevFallback: boolean;
	allowedSources: string[];
	secureCookies: boolean;
}

function parseBool(v: string | undefined, fallback: boolean): boolean {
	if (v === undefined || v === '') return fallback;
	return !['false', '0', 'no', 'non', 'off'].includes(v.trim().toLowerCase());
}

function parseMasterKey(raw: string | undefined, mode: ForgeMode): { key: Buffer; fallback: boolean } {
	if (raw && raw.trim() !== '') {
		const s = raw.trim();
		let key: Buffer | null = null;
		if (/^[0-9a-fA-F]{64}$/.test(s)) key = Buffer.from(s, 'hex');
		else {
			const b = Buffer.from(s, 'base64');
			if (b.length === 32) key = b;
		}
		if (!key) throw new Error('FORGE_MASTER_KEY doit faire 32 octets (64 caractères hexa ou base64). Générez-la : openssl rand -base64 32');
		return { key, fallback: false };
	}
	if (mode === 'mock') {
		// Clé de démonstration : uniquement en mode mock, où aucun vrai secret n'est stocké.
		return { key: createHash('sha256').update('forge-mock-mode-not-a-secret').digest(), fallback: true };
	}
	throw new Error('FORGE_MASTER_KEY manquante. Générez-la : openssl rand -base64 32');
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
	if (cached) return cached;
	const mode: ForgeMode = (env.FORGE_MODE ?? '').toLowerCase() === 'mock' ? 'mock' : 'live';
	const { key, fallback } = parseMasterKey(env.FORGE_MASTER_KEY, mode);
	cached = {
		mode,
		dryRunDefault: parseBool(env.DRY_RUN, mode === 'mock' ? false : true),
		databasePath: env.DATABASE_PATH || (mode === 'mock' ? './data/forge-mock.db' : './data/forge.db'),
		masterKey: key,
		masterKeyIsDevFallback: fallback,
		allowedSources: (env.FORGE_ALLOWED_SOURCES || '127.0.0.1/32,::1/128,10.10.10.1/32,100.64.0.0/10')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean),
		secureCookies: parseBool(env.FORGE_SECURE_COOKIES, false)
	};
	return cached;
}

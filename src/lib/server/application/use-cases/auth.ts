/** Authentification admin : mot de passe argon2id, sessions opaques (seul leur SHA-256 est stocké). */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthRepo } from '$server/infrastructure/db/repositories';
import { hashPassword, validatePasswordStrength, verifyPassword } from '$server/infrastructure/crypto/password';
import { UserFacingError } from '$lib/domain/errors';

export const SESSION_COOKIE = 'forge_session';
const SESSION_TTL_MS = 7 * 24 * 3600_000;
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 5 * 60_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class AuthService {
	#setupToken: string | null = null;
	readonly #attempts = new Map<string, { count: number; resetAt: number }>();

	constructor(
		private readonly repo: AuthRepo,
		private readonly opts: { exposeSetupToken: boolean }
	) {}

	needsSetup(): boolean {
		return !this.repo.adminHash();
	}

	/** Jeton à usage unique affiché dans les logs du conteneur, exigé pour créer le compte admin. */
	setupToken(): string {
		if (!this.#setupToken) {
			this.#setupToken = randomBytes(9).toString('base64url');
			console.log(`\n[forge] ━━ Première installation ━━\n[forge] Jeton d'installation : ${this.#setupToken}\n[forge] Ouvrez /setup pour créer le mot de passe admin.\n`);
		}
		return this.#setupToken;
	}

	/** En mode mock seulement, la page /setup peut pré-remplir le jeton. */
	exposedSetupToken(): string | null {
		return this.opts.exposeSetupToken ? this.setupToken() : null;
	}

	async setup(token: string, password: string): Promise<void> {
		if (!this.needsSetup()) throw new UserFacingError('Le compte admin existe déjà.');
		const expected = Buffer.from(this.setupToken());
		const given = Buffer.from(token.trim());
		if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
			throw new UserFacingError("Jeton d'installation incorrect (voir les logs du conteneur).");
		}
		const weak = validatePasswordStrength(password);
		if (weak) throw new UserFacingError(weak);
		this.repo.setAdminHash(await hashPassword(password));
		this.#setupToken = null;
	}

	#rateLimit(ip: string) {
		const now = Date.now();
		const a = this.#attempts.get(ip);
		if (a && a.resetAt > now && a.count >= MAX_ATTEMPTS) {
			throw new UserFacingError(`Trop de tentatives. Réessayez dans ${Math.ceil((a.resetAt - now) / 60_000)} min.`);
		}
	}

	#fail(ip: string) {
		const now = Date.now();
		const a = this.#attempts.get(ip);
		if (!a || a.resetAt <= now) this.#attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
		else a.count++;
	}

	async login(password: string, ip: string, userAgent: string | null): Promise<{ token: string; expiresAt: number }> {
		this.#rateLimit(ip);
		const hash = this.repo.adminHash();
		if (!hash || !(await verifyPassword(hash, password))) {
			this.#fail(ip);
			throw new UserFacingError('Mot de passe incorrect.');
		}
		this.#attempts.delete(ip);
		this.repo.purgeExpired();
		const token = randomBytes(32).toString('base64url');
		const expiresAt = Date.now() + SESSION_TTL_MS;
		this.repo.createSession(sha256(token), expiresAt, ip, userAgent?.slice(0, 200) ?? null);
		return { token, expiresAt };
	}

	/** Valide une session (expiration glissante). */
	validate(token: string | undefined): { expiresAt: number } | null {
		if (!token) return null;
		const id = sha256(token);
		const s = this.repo.getSession(id);
		if (!s) return null;
		if (s.expiresAt < Date.now()) {
			this.repo.deleteSession(id);
			return null;
		}
		if (s.expiresAt - Date.now() < SESSION_TTL_MS - 24 * 3600_000) {
			const expiresAt = Date.now() + SESSION_TTL_MS;
			this.repo.extendSession(id, expiresAt);
			return { expiresAt };
		}
		return s;
	}

	logout(token: string | undefined): void {
		if (token) this.repo.deleteSession(sha256(token));
	}

	async verifyCurrentPassword(password: string): Promise<boolean> {
		const hash = this.repo.adminHash();
		return !!hash && (await verifyPassword(hash, password));
	}

	async changePassword(current: string, next: string): Promise<void> {
		if (!(await this.verifyCurrentPassword(current))) throw new UserFacingError('Mot de passe actuel incorrect.');
		const weak = validatePasswordStrength(next);
		if (weak) throw new UserFacingError(weak);
		this.repo.setAdminHash(await hashPassword(next));
		this.repo.deleteAllSessions();
	}
}

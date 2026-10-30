/**
 * Authentification : comptes (un admin, des collaborateurs), mot de passe argon2id,
 * sessions opaques (seul leur SHA-256 est stocké), droits par projet.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthRepo } from '$server/infrastructure/db/repositories';
import { hashPassword, validatePasswordStrength, verifyPassword } from '$server/infrastructure/crypto/password';
import { UserFacingError } from '$lib/domain/errors';
import { isValidUsername, normalizeUsername, type AccessLevel, type Role } from '$lib/domain/access';

export const SESSION_COOKIE = 'forge_session';
const SESSION_TTL_MS = 7 * 24 * 3600_000;
const RESET_TTL_MS = 3600_000;
const ADMIN_RESET_TTL_MS = 30 * 60_000;
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 5 * 60_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface SessionUser {
	id: number;
	username: string;
	role: Role;
}

export interface UserView extends SessionUser {
	disabled: boolean;
	createdAt: number;
	projects: { projectId: number; level: AccessLevel }[];
}

export class AuthService {
	#setupToken: string | null = null;
	readonly #attempts = new Map<string, { count: number; resetAt: number }>();
	/** Hachage factice, vérifié quand l'identifiant n'existe pas (même durée de réponse). */
	#dummyHash: Promise<string> | null = null;

	constructor(
		private readonly repo: AuthRepo,
		private readonly opts: { exposeSetupToken: boolean }
	) {}

	needsSetup(): boolean {
		return this.repo.userCount() === 0;
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
		this.repo.createUser({ username: 'admin', passwordHash: await hashPassword(password), role: 'admin' });
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

	async login(username: string, password: string, ip: string, userAgent: string | null): Promise<{ token: string; expiresAt: number; user: SessionUser }> {
		this.#rateLimit(ip);
		const user = this.repo.userByUsername(normalizeUsername(username));
		const hash = user && !user.disabled ? user.passwordHash : await (this.#dummyHash ??= hashPassword(randomBytes(16).toString('hex')));
		const ok = await verifyPassword(hash, password);
		if (!user || user.disabled || !ok) {
			this.#fail(ip);
			throw new UserFacingError('Identifiant ou mot de passe incorrect.');
		}
		this.#attempts.delete(ip);
		this.repo.purgeExpired();
		const token = randomBytes(32).toString('base64url');
		const expiresAt = Date.now() + SESSION_TTL_MS;
		this.repo.createSession(sha256(token), user.id, expiresAt, ip, userAgent?.slice(0, 200) ?? null);
		return { token, expiresAt, user: { id: user.id, username: user.username, role: user.role } };
	}

	/** Valide une session (expiration glissante) et renvoie l'utilisateur. */
	validate(token: string | undefined): { expiresAt: number; user: SessionUser } | null {
		if (!token) return null;
		const id = sha256(token);
		const s = this.repo.getSession(id);
		if (!s || s.userId === null) return null;
		if (s.expiresAt < Date.now()) {
			this.repo.deleteSession(id);
			return null;
		}
		const user = this.repo.userById(s.userId);
		if (!user || user.disabled) {
			this.repo.deleteSession(id);
			return null;
		}
		let expiresAt = s.expiresAt;
		if (s.expiresAt - Date.now() < SESSION_TTL_MS - 24 * 3600_000) {
			expiresAt = Date.now() + SESSION_TTL_MS;
			this.repo.extendSession(id, expiresAt);
		}
		return { expiresAt, user: { id: user.id, username: user.username, role: user.role } };
	}

	logout(token: string | undefined): void {
		if (token) this.repo.deleteSession(sha256(token));
	}

	/** Re-saisie du mot de passe de l'utilisateur connecté (avant d'afficher un .env en clair). */
	async verifyPassword(userId: number, password: string): Promise<boolean> {
		const user = this.repo.userById(userId);
		return !!user && !user.disabled && (await verifyPassword(user.passwordHash, password));
	}

	async changePassword(userId: number, current: string, next: string): Promise<void> {
		if (!(await this.verifyPassword(userId, current))) throw new UserFacingError('Mot de passe actuel incorrect.');
		const weak = validatePasswordStrength(next);
		if (weak) throw new UserFacingError(weak);
		this.repo.setPassword(userId, await hashPassword(next));
		this.repo.deleteSessionsOf(userId);
	}

	// --- Droits par projet ---

	/** Niveau de l'utilisateur sur un projet : « edit » pour l'admin, sinon celui qui lui est assigné. */
	levelFor(user: SessionUser, projectId: number): AccessLevel | null {
		if (user.role === 'admin') return 'edit';
		return this.repo.membershipsOf(user.id).find((m) => m.projectId === projectId)?.level ?? null;
	}

	/** Projets visibles : null = tous (admin). */
	visibleProjectIds(user: SessionUser): Set<number> | null {
		if (user.role === 'admin') return null;
		return new Set(this.repo.membershipsOf(user.id).map((m) => m.projectId));
	}

	// --- Gestion des comptes (admin) ---

	listUsers(): UserView[] {
		const members = this.repo.allMemberships();
		return this.repo.listUsers().map((u) => ({
			id: u.id,
			username: u.username,
			role: u.role,
			disabled: u.disabled,
			createdAt: u.createdAt,
			projects: members.filter((m) => m.userId === u.id).map((m) => ({ projectId: m.projectId, level: m.level }))
		}));
	}

	/** Crée un collaborateur et renvoie le lien (à usage unique) pour qu'il choisisse son mot de passe. */
	async createCollaborator(rawUsername: string): Promise<{ user: SessionUser; resetToken: string }> {
		const username = normalizeUsername(rawUsername);
		if (!isValidUsername(username)) throw new UserFacingError('Identifiant invalide : 3 à 32 caractères (lettres, chiffres, point, tiret, souligné).');
		if (this.repo.userByUsername(username)) throw new UserFacingError(`L'identifiant « ${username} » existe déjà.`);
		// Mot de passe aléatoire inconnu de tous : le compte ne s'ouvre qu'avec le lien.
		const user = this.repo.createUser({ username, passwordHash: await hashPassword(randomBytes(24).toString('base64url')), role: 'collaborator' });
		return { user: { id: user.id, username: user.username, role: user.role }, resetToken: this.#issueReset(user.id, RESET_TTL_MS) };
	}

	#target(userId: number) {
		const user = this.repo.userById(userId);
		if (!user) throw new UserFacingError('Utilisateur introuvable.');
		return user;
	}

	/** Mot de passe oublié : l'admin génère un nouveau lien à usage unique (valable 1 h). */
	createResetLink(userId: number): string {
		this.#target(userId);
		return this.#issueReset(userId, RESET_TTL_MS);
	}

	#issueReset(userId: number, ttlMs: number): string {
		const token = randomBytes(24).toString('base64url');
		this.repo.createReset(sha256(token), userId, Date.now() + ttlMs);
		return token;
	}

	/** Lien de secours de l'admin (FORGE_ADMIN_RESET=1), affiché dans les logs au démarrage. */
	issueAdminResetFromHost(): string | null {
		const admin = this.repo.firstAdmin();
		return admin ? this.#issueReset(admin.id, ADMIN_RESET_TTL_MS) : null;
	}

	/** Nom du compte concerné par un lien (pour la page de réinitialisation), null si invalide ou expiré. */
	resetTarget(token: string): string | null {
		const r = this.repo.getReset(sha256(token));
		if (!r || r.expiresAt < Date.now()) return null;
		return this.repo.userById(r.userId)?.username ?? null;
	}

	async resetPassword(token: string, password: string): Promise<void> {
		const id = sha256(token);
		const r = this.repo.getReset(id);
		if (!r || r.expiresAt < Date.now()) throw new UserFacingError('Ce lien est invalide ou a expiré. Demandez-en un nouveau.');
		const weak = validatePasswordStrength(password);
		if (weak) throw new UserFacingError(weak);
		this.repo.setPassword(r.userId, await hashPassword(password));
		this.repo.deleteResetsOf(r.userId);
		this.repo.deleteSessionsOf(r.userId);
	}

	setDisabled(userId: number, disabled: boolean): void {
		const user = this.#target(userId);
		if (user.role === 'admin') throw new UserFacingError('Le compte admin ne peut pas être désactivé.');
		this.repo.setDisabled(userId, disabled);
		if (disabled) this.repo.deleteSessionsOf(userId);
	}

	deleteUser(userId: number): void {
		const user = this.#target(userId);
		if (user.role === 'admin') throw new UserFacingError('Le compte admin ne peut pas être supprimé.');
		this.repo.deleteUser(userId);
	}

	setMember(userId: number, projectId: number, level: AccessLevel | null): void {
		const user = this.#target(userId);
		if (user.role === 'admin') throw new UserFacingError("L'admin a déjà accès à tout.");
		if (level === null) this.repo.removeMember(userId, projectId);
		else this.repo.setMember(userId, projectId, level);
	}
}

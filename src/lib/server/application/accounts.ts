/**
 * Comptes GitHub et OVH supplémentaires. Le compte « principal » reste dans les réglages ;
 * les autres sont chiffrés ici (AES-256-GCM, le libellé fait partie des données authentifiées).
 */
import { UserFacingError } from '$lib/domain/errors';
import type { AccountRepo } from '$server/infrastructure/db/repositories';
import type { AccountRow } from '$server/infrastructure/db/schema';
import type { Cipher } from './settings';

export interface OvhAccountConfig {
	endpoint: string;
	appKey: string;
	appSecret: string;
	consumerKey: string;
}

export interface AccountView {
	id: number;
	kind: AccountRow['kind'];
	label: string;
	owner: string | null;
}

const aad = (kind: string, label: string) => `account:${kind}:${label}`;

export class AccountService {
	#listeners = new Set<() => void>();

	constructor(
		private readonly repo: AccountRepo,
		private readonly cipher: Cipher
	) {}

	onChange(fn: () => void): void {
		this.#listeners.add(fn);
	}

	#changed() {
		for (const fn of this.#listeners) fn();
	}

	list(): AccountView[] {
		return this.repo.list().map((a) => ({ id: a.id, kind: a.kind, label: a.label, owner: a.owner }));
	}

	#config<T>(row: AccountRow): T | null {
		try {
			return JSON.parse(this.cipher.decrypt(row.config, aad(row.kind, row.label))) as T;
		} catch {
			// Clé maître changée : le compte est illisible, on l'ignore.
			return null;
		}
	}

	githubAccounts(): { owner: string; token: string }[] {
		return this.repo.list('github').flatMap((a) => {
			const c = this.#config<{ token: string }>(a);
			return c && a.owner ? [{ owner: a.owner, token: c.token }] : [];
		});
	}

	ovhAccounts(): { label: string; config: OvhAccountConfig }[] {
		return this.repo.list('ovh').flatMap((a) => {
			const c = this.#config<OvhAccountConfig>(a);
			return c ? [{ label: a.label, config: c }] : [];
		});
	}

	/** Propriétaires GitHub supplémentaires (la politique de sécurité les autorise aussi). */
	githubOwners(): string[] {
		return this.repo.list('github').flatMap((a) => (a.owner ? [a.owner] : []));
	}

	secretValues(): string[] {
		return [...this.githubAccounts().map((a) => a.token), ...this.ovhAccounts().flatMap((a) => [a.config.appSecret, a.config.consumerKey])].filter(Boolean);
	}

	#label(kind: AccountRow['kind'], raw: string): string {
		const label = raw.trim();
		if (!label || label.length > 40) throw new UserFacingError('Libellé requis (40 caractères maximum).');
		if (this.repo.list(kind).some((a) => a.label.toLowerCase() === label.toLowerCase())) throw new UserFacingError(`Le libellé « ${label} » existe déjà.`);
		return label;
	}

	addGithub(input: { label: string; owner: string; token: string }, mainOwner: string): AccountView {
		const label = this.#label('github', input.label);
		const owner = input.owner.trim();
		if (!/^[A-Za-z0-9-]{1,39}$/.test(owner)) throw new UserFacingError('Propriétaire GitHub invalide (compte ou organisation).');
		if (!input.token.trim()) throw new UserFacingError('Jeton requis.');
		const taken = [mainOwner, ...this.githubOwners()].some((o) => o.toLowerCase() === owner.toLowerCase());
		if (taken) throw new UserFacingError(`Le propriétaire « ${owner} » est déjà couvert par un autre compte.`);
		const row = this.repo.create({ kind: 'github', label, owner, config: this.cipher.encrypt(JSON.stringify({ token: input.token.trim() }), aad('github', label)) });
		this.#changed();
		return { id: row.id, kind: row.kind, label: row.label, owner: row.owner };
	}

	addOvh(input: { label: string } & OvhAccountConfig): AccountView {
		const label = this.#label('ovh', input.label);
		const config: OvhAccountConfig = {
			endpoint: input.endpoint.trim() || 'https://eu.api.ovh.com/1.0',
			appKey: input.appKey.trim(),
			appSecret: input.appSecret.trim(),
			consumerKey: input.consumerKey.trim()
		};
		if (!config.appKey || !config.appSecret || !config.consumerKey) throw new UserFacingError('Les trois clés OVH sont requises.');
		const row = this.repo.create({ kind: 'ovh', label, owner: null, config: this.cipher.encrypt(JSON.stringify(config), aad('ovh', label)) });
		this.#changed();
		return { id: row.id, kind: row.kind, label: row.label, owner: row.owner };
	}

	remove(id: number): void {
		if (!this.repo.get(id)) throw new UserFacingError('Compte introuvable.');
		this.repo.delete(id);
		this.#changed();
	}
}

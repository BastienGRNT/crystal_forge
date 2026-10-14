/**
 * Cache court pour les LECTURES affichées (tableau de bord, pages) : une valeur reste
 * valable `ttlMs`, et des appels simultanés pour la même clé partagent une seule requête.
 * Les erreurs ne sont jamais mises en cache. Les contrôles de sécurité du garde ne
 * passent JAMAIS par ce cache : ils lisent l'état réel.
 */
interface Entry {
	at: number;
	value?: unknown;
	pending?: Promise<unknown>;
}

export class TtlCache {
	readonly #entries = new Map<string, Entry>();
	/** Incrémenté à chaque invalidation : une requête lancée avant ne remplit pas le cache. */
	#generation = 0;

	get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
		const e = this.#entries.get(key);
		if (e?.pending) return e.pending as Promise<T>;
		if (e && 'value' in e && Date.now() - e.at < ttlMs) return Promise.resolve(e.value as T);

		const generation = this.#generation;
		const pending = load().then(
			(value) => {
				if (generation === this.#generation) this.#entries.set(key, { at: Date.now(), value });
				else if (this.#entries.get(key)?.pending === pending) this.#entries.delete(key);
				return value;
			},
			(err: unknown) => {
				if (this.#entries.get(key)?.pending === pending) this.#entries.delete(key);
				throw err;
			}
		);
		this.#entries.set(key, { at: Date.now(), pending });
		return pending;
	}

	/** Oublie tout (après une écriture) : la prochaine lecture repart de l'état réel. */
	clear(): void {
		this.#generation++;
		this.#entries.clear();
	}
}

/**
 * GET JSON côté navigateur, sans jamais lever : réseau coupé, 403/500 ou réponse non JSON
 * donnent `{ ok: false, error }`. Évite les spinners bloqués et les pages qui plantent.
 */
export async function getJson<T = Record<string, unknown>>(url: string): Promise<{ ok: true; data: T } | { ok: false; error: string; data: Partial<T> | null }> {
	let res: Response;
	try {
		res = await fetch(url);
	} catch {
		return { ok: false, error: 'Forge ne répond pas : réessayez dans un instant.', data: null };
	}
	let body: unknown = null;
	try {
		body = await res.json();
	} catch {
		/* réponse non JSON */
	}
	const msg = (body as { error?: string; message?: string } | null)?.error ?? (body as { message?: string } | null)?.message;
	if (!res.ok) return { ok: false, error: msg ?? `Erreur ${res.status}`, data: (body as Partial<T>) ?? null };
	return { ok: true, data: body as T };
}

/** Numérote les requêtes : seule la dernière lancée a le droit d'écrire son résultat. */
export function latest() {
	let n = 0;
	return () => {
		const id = ++n;
		return () => id === n;
	};
}

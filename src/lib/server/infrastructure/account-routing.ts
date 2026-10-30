/**
 * Plusieurs comptes derrière une seule interface : le code métier appelle toujours
 * `github.api` / `dns.api`, ce routeur choisit le bon compte (propriétaire du dépôt, zone DNS).
 */
import type { GhRepo, GithubApi, OvhApi } from '../application/ports';

export function routeGithub(main: GithubApi, extras: () => { owner: string; api: GithubApi }[]): GithubApi {
	const pick = (owner: unknown): GithubApi => {
		const o = String(owner).toLowerCase();
		return extras().find((e) => e.owner.toLowerCase() === o)?.api ?? main;
	};
	return new Proxy({} as GithubApi, {
		get(_t, prop: string) {
			if (prop === 'whoami') return () => main.whoami();
			if (prop === 'listRepos') {
				return async (): Promise<GhRepo[]> => {
					const lists = await Promise.allSettled([
						main.listRepos(),
						...extras().map(async (e) => (await e.api.listRepos()).filter((r) => r.owner.toLowerCase() === e.owner.toLowerCase()))
					]);
					const ok = lists.flatMap((l) => (l.status === 'fulfilled' ? [l.value] : []));
					if (!ok.length) throw (lists[0] as PromiseRejectedResult).reason;
					const seen = new Set<string>();
					return ok.flat().filter((r) => !seen.has(r.fullName.toLowerCase()) && !!seen.add(r.fullName.toLowerCase()));
				};
			}
			return (...args: unknown[]) => {
				const api = pick(args[0]) as unknown as Record<string, (...a: unknown[]) => unknown>;
				return api[prop]?.(...args);
			};
		}
	});
}

export function routeOvh(main: OvhApi, extras: () => { label: string; api: OvhApi }[]): OvhApi {
	let zoneOwner = new Map<string, OvhApi>();
	let loadedAt = 0;
	const refresh = async () => {
		const next = new Map<string, OvhApi>();
		for (const api of [main, ...extras().map((e) => e.api)]) {
			const zones = await api.listZones().catch(() => [] as string[]);
			for (const z of zones) if (!next.has(z.toLowerCase())) next.set(z.toLowerCase(), api);
		}
		zoneOwner = next;
		loadedAt = Date.now();
	};
	const pick = async (zone: string): Promise<OvhApi> => {
		if (!extras().length) return main;
		const key = zone.toLowerCase();
		if (Date.now() - loadedAt > 5 * 60_000 || !zoneOwner.has(key)) await refresh();
		return zoneOwner.get(key) ?? main;
	};
	return new Proxy({} as OvhApi, {
		get(_t, prop: string) {
			if (prop === 'currentCredential') return () => main.currentCredential();
			if (prop === 'listZones') {
				return async (): Promise<string[]> => {
					const lists = await Promise.allSettled([main.listZones(), ...extras().map((e) => e.api.listZones())]);
					const ok = lists.flatMap((l) => (l.status === 'fulfilled' ? [l.value] : []));
					if (!ok.length) throw (lists[0] as PromiseRejectedResult).reason;
					return [...new Set(ok.flat())];
				};
			}
			return async (...args: unknown[]) => {
				const api = (await pick(String(args[0]))) as unknown as Record<string, (...a: unknown[]) => unknown>;
				return api[prop]?.(...args);
			};
		}
	});
}

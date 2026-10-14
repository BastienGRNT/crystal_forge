/** Tableau de bord : hôte + tous les CT (Forge et lecture seule), croisés avec NPM et GitHub. */
import { errorMessage } from '$lib/domain/errors';
import type { ProjectRow } from '$server/infrastructure/db/schema';
import type { GhRun, NpmProxyHost, PveGuest, PveNodeStatus, PveStorageStatus } from '../ports';
import { TtlCache } from '../cache';
import { mapLimit } from '../gateways';
import type { ForgeServices } from '../services';

export type CardKind = 'forge' | 'readonly' | 'template' | 'orphan';

export interface CtCard {
	vmid: number;
	name: string;
	type: 'lxc' | 'qemu';
	status: string;
	kind: CardKind;
	pool: string | null;
	ip: string | null;
	cpu: number;
	maxcpu: number;
	mem: number;
	maxmem: number;
	disk: number;
	maxdisk: number;
	uptime: number;
	tags: string[];
	project: { slug: string; name: string; status: ProjectRow['status'] } | null;
	repo: string | null;
	domains: { fqdn: string; port: number; certExpiresOn: string | null; online: boolean | null }[];
	lastRun: { runNumber: number; status: string; conclusion: string | null; createdAt: string; htmlUrl: string; commitMessage: string | null } | null;
}

export interface DashboardData {
	host: (PveNodeStatus & { storage: PveStorageStatus | null }) | null;
	cards: CtCard[];
	errors: { system: string; message: string }[];
	fetchedAt: number;
}

/** Partie GitHub du tableau de bord, transmise en différé : dépôt et dernier run par CT. */
export interface DashboardGithub {
	byVmid: Record<number, { repo: string | null; lastRun: CtCard['lastRun'] }>;
	error: string | null;
}

const RUNNER_MAP_TTL = 10 * 60_000;
const LAST_RUN_TTL = 60_000;

export class DashboardService {
	readonly #cache = new TtlCache();

	constructor(private readonly s: ForgeServices) {}

	/** Correspondance nom de runner → dépôt (heuristique : le runner porte le hostname du CT). */
	#runnersToRepos(): Promise<Map<string, string>> {
		return this.#cache.get('runners', RUNNER_MAP_TTL, async () => {
			const map = new Map<string, string>();
			const repos = (await this.s.github.api.listRepos()).filter((r) => !r.archived);
			await mapLimit(repos, 6, async (r) => {
				try {
					for (const runner of await this.s.github.api.listRunners(r.owner, r.name)) map.set(runner.name.toLowerCase(), r.fullName);
				} catch {
					/* dépôt sans accès admin */
				}
			});
			return map;
		});
	}

	#lastRun(fullName: string): Promise<GhRun | null> {
		return this.#cache.get(`run:${fullName}`, LAST_RUN_TTL, async () => {
			const [owner, repo] = fullName.split('/') as [string, string];
			return (await this.s.github.api.listRepoRuns(owner, repo, 1))[0] ?? null;
		});
	}

	/** Proxmox et NPM (rapides, en cache) tout de suite ; GitHub en différé. */
	async load(): Promise<DashboardData & { github: Promise<DashboardGithub> }> {
		const { proxmox, proxy, settings, repos } = this.s;
		const errors: DashboardData['errors'] = [];
		const pool = settings.get('proxmox.pool');
		const protectedIds = settings.safetyContext().protectedCtids;

		const [nodeR, storageR, guestsR, hostsR, ipsR] = await Promise.allSettled([
			proxmox.nodeStatus(),
			proxmox.storageStatus(),
			proxmox.guests(),
			proxy.listHosts(),
			proxmox.guestIps()
		]);
		if (nodeR.status === 'rejected') errors.push({ system: 'Proxmox', message: errorMessage(nodeR.reason) });
		if (guestsR.status === 'rejected' && nodeR.status === 'fulfilled') errors.push({ system: 'Proxmox', message: errorMessage(guestsR.reason) });
		if (hostsR.status === 'rejected') errors.push({ system: 'NPM', message: errorMessage(hostsR.reason) });

		const guests: PveGuest[] = guestsR.status === 'fulfilled' ? guestsR.value : [];
		const hosts: NpmProxyHost[] = hostsR.status === 'fulfilled' ? hostsR.value : [];
		const ips = ipsR.status === 'fulfilled' ? ipsR.value : new Map<number, string[]>();
		const projects = repos.projects.list();
		const repoMap = settings.repoMap();

		const cards: CtCard[] = guests.map((g) => {
			const project = projects.find((p) => p.ctid === g.vmid) ?? null;
			const ip = ips.get(g.vmid)?.[0] ?? null;
			let kind: CardKind = 'readonly';
			if (g.template) kind = 'template';
			else if (g.pool === pool && !protectedIds.includes(g.vmid)) kind = project ? 'forge' : 'orphan';
			return {
				vmid: g.vmid,
				name: g.name,
				type: g.type,
				status: g.status,
				kind,
				pool: g.pool,
				ip,
				cpu: g.cpu,
				maxcpu: g.maxcpu,
				mem: g.mem,
				maxmem: g.maxmem,
				disk: g.disk,
				maxdisk: g.maxdisk,
				uptime: g.uptime,
				tags: g.tags,
				project: project ? { slug: project.slug, name: project.name, status: project.status } : null,
				repo: project ? `${project.repoOwner}/${project.repoName}` : (repoMap[String(g.vmid)] ?? null),
				domains: ip
					? hosts
							.filter((h) => h.forwardHost === ip)
							.flatMap((h) => h.domainNames.map((fqdn) => ({ fqdn, port: h.forwardPort, certExpiresOn: h.certificate?.expiresOn ?? null, online: h.nginxOnline })))
					: [],
				lastRun: null
			};
		});

		const order: Record<CardKind, number> = { forge: 0, orphan: 1, readonly: 2, template: 3 };
		cards.sort((a, b) => order[a.kind] - order[b.kind] || a.vmid - b.vmid);

		return {
			host: nodeR.status === 'fulfilled' ? { ...nodeR.value, storage: storageR.status === 'fulfilled' ? storageR.value : null } : null,
			cards,
			errors,
			fetchedAt: Date.now(),
			github: this.#github(cards)
		};
	}

	async #github(cards: CtCard[]): Promise<DashboardGithub> {
		const byVmid: DashboardGithub['byVmid'] = {};
		let error: string | null = null;
		const live = cards.filter((c) => c.kind !== 'template');
		// La correspondance runner → dépôt (un appel par dépôt) n'est utile que pour les CT sans dépôt connu.
		let runnerMap = new Map<string, string>();
		if (live.some((c) => !c.repo)) {
			try {
				runnerMap = await this.#runnersToRepos();
			} catch (err) {
				error = errorMessage(err);
			}
		}
		await mapLimit(live, 6, async (c) => {
			const repo = c.repo ?? runnerMap.get(c.name.toLowerCase()) ?? null;
			let lastRun: CtCard['lastRun'] = null;
			if (repo) {
				try {
					const r = await this.#lastRun(repo);
					if (r) lastRun = { runNumber: r.runNumber, status: r.status, conclusion: r.conclusion, createdAt: r.createdAt, htmlUrl: r.htmlUrl, commitMessage: r.commitMessage };
				} catch {
					/* pas d'accès aux Actions de ce dépôt */
				}
			}
			byVmid[c.vmid] = { repo, lastRun };
		});
		return { byVmid, error };
	}
}

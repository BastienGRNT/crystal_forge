/** Tableau de bord : hôte + tous les CT (Forge et lecture seule), croisés avec NPM et GitHub. */
import { errorMessage } from '$lib/domain/errors';
import { ipsFromGuestConfig } from '$lib/domain/network';
import type { ProjectRow } from '$server/infrastructure/db/schema';
import type { GhRun, NpmProxyHost, PveGuest, PveNodeStatus, PveStorageStatus } from '../ports';
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

interface Cache<T> {
	at: number;
	value: T;
}

export class DashboardService {
	#runnerMap: Cache<Map<string, string>> | null = null;
	#runs = new Map<string, Cache<GhRun | null>>();

	constructor(private readonly s: ForgeServices) {}

	/** Correspondance nom de runner → dépôt (heuristique : le runner porte le hostname du CT). */
	async #runnersToRepos(): Promise<Map<string, string>> {
		if (this.#runnerMap && Date.now() - this.#runnerMap.at < 10 * 60_000) return this.#runnerMap.value;
		const map = new Map<string, string>();
		const repos = await this.s.github.api.listRepos();
		await Promise.all(
			repos
				.filter((r) => !r.archived)
				.map(async (r) => {
					try {
						for (const runner of await this.s.github.api.listRunners(r.owner, r.name)) map.set(runner.name.toLowerCase(), r.fullName);
					} catch {
						/* dépôt sans accès admin */
					}
				})
		);
		this.#runnerMap = { at: Date.now(), value: map };
		return map;
	}

	async #lastRun(fullName: string): Promise<GhRun | null> {
		const c = this.#runs.get(fullName);
		if (c && Date.now() - c.at < 30_000) return c.value;
		const [owner, repo] = fullName.split('/') as [string, string];
		const run = (await this.s.github.api.listRepoRuns(owner, repo, 1))[0] ?? null;
		this.#runs.set(fullName, { at: Date.now(), value: run });
		return run;
	}

	async load(): Promise<DashboardData> {
		const { proxmox, proxy, settings, repos } = this.s;
		const errors: DashboardData['errors'] = [];
		const pool = settings.get('proxmox.pool');
		const protectedIds = settings.safetyContext().protectedCtids;

		const [nodeR, storageR, guestsR, hostsR] = await Promise.allSettled([
			proxmox.nodeStatus(),
			proxmox.storageStatus(),
			proxmox.guests(),
			proxy.listHosts()
		]);
		if (nodeR.status === 'rejected') errors.push({ system: 'Proxmox', message: errorMessage(nodeR.reason) });
		if (guestsR.status === 'rejected' && nodeR.status === 'fulfilled') errors.push({ system: 'Proxmox', message: errorMessage(guestsR.reason) });
		if (hostsR.status === 'rejected') errors.push({ system: 'NPM', message: errorMessage(hostsR.reason) });

		const guests: PveGuest[] = guestsR.status === 'fulfilled' ? guestsR.value : [];
		const hosts: NpmProxyHost[] = hostsR.status === 'fulfilled' ? hostsR.value : [];
		const projects = repos.projects.list();
		const repoMap = settings.repoMap();

		const ips = new Map<number, string>();
		await Promise.all(
			guests.map(async (g) => {
				try {
					const ip = ipsFromGuestConfig(await proxmox.guestConfig(g.vmid, g.type))[0];
					if (ip) ips.set(g.vmid, ip);
				} catch {
					/* lecture de config refusée */
				}
			})
		);

		let runnerMap = new Map<string, string>();
		try {
			runnerMap = await this.#runnersToRepos();
		} catch (err) {
			errors.push({ system: 'GitHub', message: errorMessage(err) });
		}

		const cards: CtCard[] = await Promise.all(
			guests.map(async (g) => {
				const project = projects.find((p) => p.ctid === g.vmid) ?? null;
				const ip = ips.get(g.vmid) ?? null;
				let kind: CardKind = 'readonly';
				if (g.template) kind = 'template';
				else if (g.pool === pool && !protectedIds.includes(g.vmid)) kind = project ? 'forge' : 'orphan';
				const repo = project ? `${project.repoOwner}/${project.repoName}` : (repoMap[String(g.vmid)] ?? runnerMap.get(g.name.toLowerCase()) ?? null);
				let lastRun: CtCard['lastRun'] = null;
				if (repo && !g.template) {
					try {
						const r = await this.#lastRun(repo);
						if (r) lastRun = { runNumber: r.runNumber, status: r.status, conclusion: r.conclusion, createdAt: r.createdAt, htmlUrl: r.htmlUrl, commitMessage: r.commitMessage };
					} catch {
						/* pas d'accès aux Actions de ce dépôt */
					}
				}
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
					repo,
					domains: ip
						? hosts
								.filter((h) => h.forwardHost === ip)
								.flatMap((h) => h.domainNames.map((fqdn) => ({ fqdn, port: h.forwardPort, certExpiresOn: h.certificate?.expiresOn ?? null, online: h.nginxOnline })))
						: [],
					lastRun
				};
			})
		);

		const order: Record<CardKind, number> = { forge: 0, orphan: 1, readonly: 2, template: 3 };
		cards.sort((a, b) => order[a.kind] - order[b.kind] || a.vmid - b.vmid);

		return {
			host: nodeR.status === 'fulfilled' ? { ...nodeR.value, storage: storageR.status === 'fulfilled' ? storageR.value : null } : null,
			cards,
			errors,
			fetchedAt: Date.now()
		};
	}
}

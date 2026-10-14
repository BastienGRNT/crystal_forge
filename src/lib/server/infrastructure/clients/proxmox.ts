/**
 * Client API Proxmox VE 9 (jeton API, https://<hôte>:8006/api2/json).
 * Ce client ne fait AUCUN contrôle de sécurité : il est toujours utilisé derrière
 * ProxmoxGateway (garde + règles). Les droits réels sont bornés par les ACL du jeton.
 */
import type { Agent } from 'undici';
import { ExternalApiError } from '$lib/domain/errors';
import type {
	PowerAction,
	ProxmoxApi,
	PveCloneParams,
	PveGuest,
	PveNodeStatus,
	PveBackupJob,
	PveFirewallRule,
	PveNetworkIface,
	PvePermissions,
	PveStorageStatus,
	PveTaskStatus
} from '$server/application/ports';
import { httpRequest, parseJson, proxmoxDispatcher } from './http';

export interface ProxmoxConfig {
	url: string;
	node: string;
	tokenId: string;
	tokenSecret: string;
	caCert: string;
}

type Params = Record<string, string | number | boolean | undefined>;

export class ProxmoxClient implements ProxmoxApi {
	readonly #dispatcher: Agent;

	constructor(private readonly cfg: ProxmoxConfig) {
		if (!cfg.tokenSecret) throw new ExternalApiError('Proxmox', 'jeton API non configuré (Réglages → Proxmox)');
		this.#dispatcher = proxmoxDispatcher(cfg.caCert);
	}

	get #node() {
		return encodeURIComponent(this.cfg.node);
	}

	async #call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, params: Params = {}, timeoutMs = 30_000): Promise<T> {
		const entries = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string | number | boolean][];
		const qs = new URLSearchParams(entries.map(([k, v]) => [k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v)]));
		const base = this.cfg.url.replace(/\/+$/, '') + '/api2/json' + path;
		const isBody = method === 'POST' || method === 'PUT';
		const url = !isBody && entries.length ? `${base}?${qs}` : base;
		const res = await httpRequest('Proxmox', url, {
			method,
			timeoutMs,
			dispatcher: this.#dispatcher,
			headers: {
				Authorization: `PVEAPIToken=${this.cfg.tokenId}=${this.cfg.tokenSecret}`,
				...(isBody ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
			},
			body: isBody ? qs.toString() : undefined
		});
		if (res.status >= 400) {
			// Proxmox place souvent le message d'erreur dans le texte du statut HTTP.
			let detail = res.statusText;
			try {
				const j = JSON.parse(res.text) as { errors?: Record<string, string>; message?: string };
				if (j.errors) detail += ' — ' + Object.entries(j.errors).map(([k, v]) => `${k}: ${v}`).join('; ');
				else if (j.message) detail += ' — ' + j.message;
			} catch {
				/* corps non JSON */
			}
			if (res.status === 401) detail = 'authentification refusée (jeton invalide ?)';
			if (res.status === 403) detail = `permission refusée — ${detail}`;
			throw new ExternalApiError('Proxmox', `${method} ${path} : HTTP ${res.status} ${detail}`, res.status);
		}
		return parseJson<{ data: T }>('Proxmox', res.text).data;
	}

	version() {
		return this.#call<{ version: string; release: string }>('GET', '/version');
	}

	async nodeStatus(): Promise<PveNodeStatus> {
		const s = await this.#call<{
			cpu: number;
			cpuinfo: { cpus: number };
			memory: { total: number; used: number; free: number };
			swap: { total: number; used: number };
			rootfs: { total: number; used: number };
			uptime: number;
			loadavg: string[];
			pveversion: string;
		}>('GET', `/nodes/${this.#node}/status`);
		return {
			cpu: s.cpu,
			cpus: s.cpuinfo?.cpus ?? 0,
			memory: s.memory,
			swap: s.swap,
			rootfs: s.rootfs,
			uptime: s.uptime,
			loadavg: s.loadavg ?? [],
			pveversion: s.pveversion
		};
	}

	storageStatus(storage: string) {
		return this.#call<PveStorageStatus>('GET', `/nodes/${this.#node}/storage/${encodeURIComponent(storage)}/status`);
	}

	async guests(): Promise<PveGuest[]> {
		const rows = await this.#call<
			{
				vmid: number;
				name?: string;
				type: string;
				status: string;
				node: string;
				pool?: string;
				template?: number;
				tags?: string;
				cpu?: number;
				maxcpu?: number;
				mem?: number;
				maxmem?: number;
				disk?: number;
				maxdisk?: number;
				uptime?: number;
			}[]
		>('GET', '/cluster/resources', { type: 'vm' });
		return rows
			.filter((r) => r.type === 'lxc' || r.type === 'qemu')
			.map((r) => ({
				vmid: r.vmid,
				name: r.name ?? `${r.type}-${r.vmid}`,
				type: r.type as 'lxc' | 'qemu',
				status: r.status,
				node: r.node,
				pool: r.pool ?? null,
				template: r.template === 1,
				tags: (r.tags ?? '').split(/[;, ]/).filter(Boolean),
				cpu: r.cpu ?? 0,
				maxcpu: r.maxcpu ?? 0,
				mem: r.mem ?? 0,
				maxmem: r.maxmem ?? 0,
				disk: r.disk ?? 0,
				maxdisk: r.maxdisk ?? 0,
				uptime: r.uptime ?? 0
			}))
			.sort((a, b) => a.vmid - b.vmid);
	}

	guestConfig(vmid: number, type: 'lxc' | 'qemu') {
		return this.#call<Record<string, unknown>>('GET', `/nodes/${this.#node}/${type}/${vmid}/config`);
	}

	permissions(path?: string) {
		return this.#call<PvePermissions>('GET', '/access/permissions', { path });
	}

	async poolMembers(pool: string): Promise<number[]> {
		const p = await this.#call<{ members?: { vmid?: number }[] }>('GET', `/pools/${encodeURIComponent(pool)}`);
		return (p.members ?? []).map((m) => m.vmid).filter((v): v is number => typeof v === 'number');
	}

	async isIdFree(vmid: number): Promise<boolean> {
		try {
			await this.#call('GET', '/cluster/nextid', { vmid });
			return true;
		} catch (err) {
			if (err instanceof ExternalApiError && err.status === 400) return false;
			throw err;
		}
	}

	taskStatus(upid: string) {
		return this.#call<PveTaskStatus>('GET', `/nodes/${this.#node}/tasks/${encodeURIComponent(upid)}/status`);
	}

	taskLog(upid: string, start: number) {
		return this.#call<{ n: number; t: string }[]>('GET', `/nodes/${this.#node}/tasks/${encodeURIComponent(upid)}/log`, {
			start,
			limit: 500
		});
	}

	async listBackups(storage: string, vmid: number) {
		const rows = await this.#call<{ volid: string; ctime: number; size: number }[]>(
			'GET',
			`/nodes/${this.#node}/storage/${encodeURIComponent(storage)}/content`,
			{ content: 'backup', vmid }
		);
		return rows.sort((a, b) => b.ctime - a.ctime);
	}

	ctFirewallOptions(vmid: number) {
		return this.#call<Record<string, unknown>>('GET', `/nodes/${this.#node}/lxc/${vmid}/firewall/options`);
	}

	async ctFirewallRules(vmid: number) {
		const rows = await this.#call<PveFirewallRule[]>('GET', `/nodes/${this.#node}/lxc/${vmid}/firewall/rules`);
		return rows.sort((a, b) => a.pos - b.pos);
	}

	clusterFirewallOptions() {
		return this.#call<Record<string, unknown>>('GET', '/cluster/firewall/options');
	}

	nodeNetworks() {
		return this.#call<PveNetworkIface[]>('GET', `/nodes/${this.#node}/network`);
	}

	async backupJobs(): Promise<PveBackupJob[]> {
		const rows = await this.#call<{ id: string; enabled?: number; schedule?: string; vmid?: string; all?: number; storage?: string }[]>('GET', '/cluster/backup');
		return rows.map((r) => ({
			id: r.id,
			enabled: r.enabled !== 0,
			schedule: r.schedule ?? '',
			vmid: r.vmid ?? null,
			all: r.all === 1,
			storage: r.storage ?? null
		}));
	}

	clone(sourceId: number, p: PveCloneParams) {
		return this.#call<string>('POST', `/nodes/${this.#node}/lxc/${sourceId}/clone`, {
			newid: p.newid,
			hostname: p.hostname,
			pool: p.pool,
			storage: p.storage,
			full: p.full,
			description: p.description
		});
	}

	async updateConfig(vmid: number, config: Record<string, string | number>) {
		await this.#call('PUT', `/nodes/${this.#node}/lxc/${vmid}/config`, config);
	}

	async resize(vmid: number, disk: string, size: string) {
		const r = await this.#call<string | null>('PUT', `/nodes/${this.#node}/lxc/${vmid}/resize`, { disk, size });
		return typeof r === 'string' ? r : null;
	}

	power(vmid: number, action: PowerAction) {
		return this.#call<string>('POST', `/nodes/${this.#node}/lxc/${vmid}/status/${action}`, action === 'shutdown' ? { timeout: 60 } : {});
	}

	destroy(vmid: number) {
		return this.#call<string>('DELETE', `/nodes/${this.#node}/lxc/${vmid}`, { purge: 1, 'destroy-unreferenced-disks': 1 });
	}

	vzdump(vmid: number, storage: string) {
		return this.#call<string>('POST', `/nodes/${this.#node}/vzdump`, {
			vmid: String(vmid),
			storage,
			mode: 'snapshot',
			compress: 'zstd',
			'notes-template': '{{guestname}} — sauvegarde Forge avant suppression'
		});
	}

	async setCtFirewallOptions(vmid: number, options: Record<string, string | number>) {
		await this.#call('PUT', `/nodes/${this.#node}/lxc/${vmid}/firewall/options`, options);
	}

	async addCtFirewallRule(vmid: number, rule: Record<string, string | number>) {
		// Sans « pos », Proxmox insère la règle en tête : l'appelant ajoute dans l'ordre inverse.
		await this.#call('POST', `/nodes/${this.#node}/lxc/${vmid}/firewall/rules`, rule);
	}

	async deleteCtFirewallRule(vmid: number, pos: number) {
		await this.#call('DELETE', `/nodes/${this.#node}/lxc/${vmid}/firewall/rules/${pos}`);
	}
}

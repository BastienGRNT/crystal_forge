/**
 * Implémentations simulées des ports, branchées sur le monde en mémoire (world.ts).
 * Elles reproduisent le comportement observable des vraies API (tâches Proxmox
 * asynchrones, ACL du jeton forge@pve, runs GitHub qui attendent un runner en ligne,
 * propagation DNS, certbot de NPM qui échoue si le DNS ne résout pas…).
 */
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { ExternalApiError } from '$lib/domain/errors';
import { parseNetConfig } from '$lib/domain/network';
import { generateBoxKeyPair } from '$server/infrastructure/crypto/sealed-box';
import type {
	ExternalApis,
	GhRun,
	GhRunJob,
	GithubApi,
	NpmApi,
	NpmCreateProxyHost,
	NpmProxyHost,
	OvhApi,
	PowerAction,
	ProbeApi,
	ProxmoxApi,
	PveCloneParams,
	PvePermissions,
	ResolverApi,
	SshApi,
	SshResult,
	SshTarget
} from '$server/application/ports';
import { demoTables, GiB, HOST, MiB, runSteps, world, type FakeFwRule, type FakeGuest, type FakeTable, type FakeNpmHost, type FakeRepo, type FakeRun, type FakeTask } from './world';

const delay = (min = 60, max = 220) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
const NODE = 'ns3125740';

function guestIp(g: FakeGuest): string | undefined {
	return parseNetConfig(String(g.config.net0 ?? '')).ip;
}

function guestByIp(ip: string): FakeGuest | undefined {
	return [...world().guests.values()].find((g) => !g.template && guestIp(g) === ip);
}

function sshReady(g: FakeGuest | undefined): boolean {
	return !!g && g.status === 'running' && Date.now() - g.startedAt > 4000;
}

// =================================================================================
// Proxmox
// =================================================================================

const AUDITOR = ['Sys.Audit', 'VM.Audit', 'Datastore.Audit', 'Pool.Audit', 'SDN.Audit', 'Mapping.Audit'];
const VMADMIN = [
	'VM.Allocate',
	'VM.Audit',
	'VM.Backup',
	'VM.Clone',
	'VM.Config.CDROM',
	'VM.Config.CPU',
	'VM.Config.Cloudinit',
	'VM.Config.Disk',
	'VM.Config.HWType',
	'VM.Config.Memory',
	'VM.Config.Network',
	'VM.Config.Options',
	'VM.Console',
	'VM.Migrate',
	'VM.PowerMgmt',
	'VM.Snapshot',
	'VM.Snapshot.Rollback'
];

function privs(list: string[]): Record<string, number> {
	return Object.fromEntries(list.map((p) => [p, 1]));
}

class FakeProxmox implements ProxmoxApi {
	#task(lines: string[], durationMs: number, onDone?: () => void, exitstatus = 'OK'): string {
		const w = world();
		const upid = `UPID:${NODE}:${(w.nextUpid++).toString(16).padStart(8, '0').toUpperCase()}:mock`;
		w.tasks.set(upid, { upid, startedAt: Date.now(), durationMs, lines, exitstatus, done: false, onDone });
		return upid;
	}

	#tick(t: FakeTask) {
		if (!t.done && Date.now() - t.startedAt >= t.durationMs) {
			t.done = true;
			t.onDone?.();
		}
	}

	/** Reproduit les ACL du jeton forge@pve : écriture uniquement dans le pool forge. */
	#requireWrite(vmid: number, priv: string) {
		const g = world().guests.get(vmid);
		if (!g) throw new ExternalApiError('Proxmox', `Configuration file 'nodes/${NODE}/lxc/${vmid}.conf' does not exist`, 500);
		if (g.pool !== 'forge') {
			throw new ExternalApiError('Proxmox', `HTTP 403 Permission check failed (/vms/${vmid}, ${priv})`, 403);
		}
		return g;
	}

	async version() {
		await delay();
		return { version: '9.1.4', release: '9.1' };
	}

	async nodeStatus() {
		await delay();
		const extra = [...world().guests.values()]
			.filter((g) => g.status === 'running' && g.vmid >= 502 && g.vmid < 600)
			.reduce((acc, g) => acc + g.memMb * MiB * g.baseMemRatio, 0);
		const t = Date.now() / 1000;
		const used = HOST.baseUsed + extra + Math.sin(t / 37) * 120 * MiB;
		return {
			cpu: 0.09 + 0.04 * Math.abs(Math.sin(t / 23)),
			cpus: HOST.cpus,
			memory: { total: HOST.memTotal, used, free: HOST.memTotal - used, arc: 0 },
			swap: { total: 8 * GiB, used: 1.2 * GiB },
			rootfs: { total: HOST.rootfsTotal, used: HOST.rootfsUsed + world().backups.reduce((a, b) => a + b.size, 0) },
			uptime: 86400 * 41 + Math.floor((Date.now() - world().createdAt) / 1000),
			loadavg: ['0.62', '0.71', '0.66'],
			pveversion: 'pve-manager/9.1.4/5b2a8c1f0e2d3a4b'
		};
	}

	async storageStatus() {
		await delay();
		const used = HOST.rootfsUsed + world().backups.reduce((a, b) => a + b.size, 0);
		return { total: HOST.rootfsTotal, used, avail: HOST.rootfsTotal - used, content: 'backup,vztmpl,rootdir,iso,images' };
	}

	async guests() {
		await delay();
		const t = Date.now() / 1000;
		return [...world().guests.values()]
			.sort((a, b) => a.vmid - b.vmid)
			.map((g) => {
				const running = g.status === 'running';
				const jitter = Math.sin(t / 11 + g.vmid) * 0.5 + 0.5;
				return {
					vmid: g.vmid,
					name: g.name,
					type: g.type,
					status: g.status,
					node: NODE,
					pool: g.pool,
					template: g.template,
					tags: g.tags,
					cpu: running ? g.baseCpu * (0.6 + jitter) : 0,
					maxcpu: g.cores,
					mem: running ? g.memMb * MiB * g.baseMemRatio * (0.97 + jitter * 0.06) : 0,
					maxmem: g.memMb * MiB,
					disk: g.diskUsedGb * GiB,
					maxdisk: g.diskGb * GiB,
					uptime: running ? Math.floor((Date.now() - g.startedAt) / 1000) : 0
				};
			});
	}

	async guestConfig(vmid: number) {
		await delay(30, 90);
		const g = world().guests.get(vmid);
		if (!g) throw new ExternalApiError('Proxmox', `Configuration file 'nodes/${NODE}/lxc/${vmid}.conf' does not exist`, 500);
		return { ...g.config, digest: createHash('sha1').update(JSON.stringify(g.config)).digest('hex') };
	}

	async permissions(path?: string): Promise<PvePermissions> {
		await delay();
		const all: PvePermissions = {
			'/': privs(AUDITOR),
			'/pool/forge': privs([...AUDITOR, ...VMADMIN]),
			'/storage/local': privs(['Datastore.Audit', 'Datastore.AllocateSpace']),
			'/sdn/zones/localnetwork/nat': privs(['SDN.Audit', 'SDN.Use'])
		};
		for (const g of world().guests.values()) {
			all[`/vms/${g.vmid}`] = privs(g.pool === 'forge' ? [...AUDITOR, ...VMADMIN] : ['VM.Audit']);
		}
		if (!path) return all;
		if (all[path]) return { [path]: all[path] as Record<string, number> };
		if (path.startsWith('/sdn/')) return { [path]: privs(['SDN.Audit']) };
		return { [path]: privs(AUDITOR) };
	}

	async poolMembers(pool: string) {
		await delay(30, 90);
		return [...world().guests.values()].filter((g) => g.pool === pool).map((g) => g.vmid);
	}

	async isIdFree(vmid: number) {
		await delay(20, 60);
		return !world().guests.has(vmid);
	}

	async taskStatus(upid: string) {
		await delay(20, 60);
		const t = world().tasks.get(upid);
		if (!t) throw new ExternalApiError('Proxmox', `no such task '${upid}'`, 500);
		this.#tick(t);
		return t.done ? { status: 'stopped' as const, exitstatus: t.exitstatus } : { status: 'running' as const };
	}

	async taskLog(upid: string, start: number) {
		const t = world().tasks.get(upid);
		if (!t) return [];
		const ratio = Math.min(1, (Date.now() - t.startedAt) / t.durationMs);
		const visible = Math.max(1, Math.floor(t.lines.length * ratio));
		return t.lines.slice(0, visible).map((line, i) => ({ n: i + 1, t: line })).filter((l) => l.n > start);
	}

	async ctFirewallOptions(vmid: number) {
		await delay(30, 90);
		if (!world().guests.has(vmid)) throw new ExternalApiError('Proxmox', `HTTP 500 Configuration file 'nodes/${NODE}/lxc/${vmid}.conf' does not exist`, 500);
		return { ...(world().firewalls.get(vmid)?.options ?? {}) };
	}

	async ctFirewallRules(vmid: number) {
		await delay(30, 90);
		return (world().firewalls.get(vmid)?.rules ?? []).map((r) => ({ ...r }));
	}

	async clusterFirewallOptions() {
		await delay(30, 90);
		return { ...world().clusterFirewall };
	}

	async nodeNetworks() {
		await delay(30, 90);
		return [
			{ iface: 'vmbr0', type: 'bridge', active: 1, cidr: '51.68.180.212/24', address: '51.68.180.212' },
			{ iface: 'nat', type: 'bridge', active: 1, cidr: '10.10.10.1/24', address: '10.10.10.1' },
			{ iface: 'eno1', type: 'eth', active: 1 },
			{ iface: 'tailscale0', type: 'unknown', active: 1 }
		];
	}

	async backupJobs() {
		await delay(30, 90);
		return world().backupJobs.map((j) => ({ ...j }));
	}

	#fw(vmid: number) {
		const w = world();
		let fw = w.firewalls.get(vmid);
		if (!fw) {
			fw = { options: {}, rules: [] };
			w.firewalls.set(vmid, fw);
		}
		return fw;
	}

	async setCtFirewallOptions(vmid: number, options: Record<string, string | number>) {
		await delay();
		this.#requireWrite(vmid, 'VM.Config.Network');
		Object.assign(this.#fw(vmid).options, options);
	}

	async addCtFirewallRule(vmid: number, rule: Record<string, string | number>) {
		await delay(20, 60);
		this.#requireWrite(vmid, 'VM.Config.Network');
		const fw = this.#fw(vmid);
		fw.rules = [{ ...(rule as unknown as FakeFwRule), pos: 0 }, ...fw.rules].map((r, i) => ({ ...r, pos: i }));
	}

	async deleteCtFirewallRule(vmid: number, pos: number) {
		await delay(20, 60);
		this.#requireWrite(vmid, 'VM.Config.Network');
		const fw = this.#fw(vmid);
		fw.rules = fw.rules.filter((r) => r.pos !== pos).map((r, i) => ({ ...r, pos: i }));
	}

	async listBackups(_storage: string, vmid: number) {
		await delay();
		return world()
			.backups.filter((b) => b.vmid === vmid)
			.map((b) => ({ volid: b.volid, ctime: b.ctime, size: b.size }))
			.sort((a, b) => b.ctime - a.ctime);
	}

	async clone(sourceId: number, p: PveCloneParams) {
		await delay();
		const w = world();
		const src = w.guests.get(sourceId);
		if (!src) throw new ExternalApiError('Proxmox', `CT ${sourceId} does not exist`, 500);
		if (src.pool !== 'forge') throw new ExternalApiError('Proxmox', `HTTP 403 Permission check failed (/vms/${sourceId}, VM.Clone)`, 403);
		if (p.pool !== 'forge') throw new ExternalApiError('Proxmox', `HTTP 403 Permission check failed (/vms/${p.newid}, VM.Allocate)`, 403);
		if (w.guests.has(p.newid)) throw new ExternalApiError('Proxmox', `CT ${p.newid} already exists`, 500);
		const lines = [
			`create full clone of mountpoint rootfs (local:${sourceId}/base-${sourceId}-disk-0.raw)`,
			`Formatting '/var/lib/vz/images/${p.newid}/vm-${p.newid}-disk-0.raw', fmt=raw size=6442450944`,
			'Creating filesystem with 1572864 4k blocks and 393216 inodes',
			'Allocating group tables: done',
			'Writing superblocks and filesystem accounting information: done',
			'Number of files: 61,412 (reg: 47,903, dir: 6,882, link: 6,594)',
			'transferred 2.71 GiB of 6.00 GiB (45.18%)',
			'transferred 6.00 GiB of 6.00 GiB (100.00%)',
			'TASK OK'
		];
		// Réservation immédiate de l'ID (comme le verrou de Proxmox pendant le clone).
		return this.#task(lines, 5000, () => {
			w.guests.set(p.newid, {
				...structuredClone(src),
				vmid: p.newid,
				name: p.hostname,
				template: false,
				status: 'stopped',
				pool: p.pool,
				tags: [],
				diskUsedGb: 2.4,
				baseCpu: 0.02 + Math.random() * 0.03,
				baseMemRatio: 0.25,
				startedAt: Date.now(),
				// Comme Proxmox : la config est recopiée telle quelle, protection comprise.
				config: { ...structuredClone(src.config), hostname: p.hostname, description: p.description ?? '', template: 0 }
			});
		});
	}

	async updateConfig(vmid: number, config: Record<string, string | number>) {
		await delay();
		const g = this.#requireWrite(vmid, 'VM.Config.Options');
		if ('features' in config) throw new ExternalApiError('Proxmox', "HTTP 403 changing feature flags is only allowed for root@pam", 403);
		for (const [k, v] of Object.entries(config)) {
			g.config[k] = v;
			if (k === 'cores') g.cores = Number(v);
			if (k === 'memory') g.memMb = Number(v);
			if (k === 'hostname') g.name = String(v);
			if (k === 'tags') g.tags = String(v).split(/[;, ]/).filter(Boolean);
		}
	}

	async resize(vmid: number, _disk: string, size: string) {
		await delay();
		const g = this.#requireWrite(vmid, 'VM.Config.Disk');
		const gb = Number.parseInt(size, 10);
		if (gb < g.diskGb) throw new ExternalApiError('Proxmox', 'unable to shrink disk size', 500);
		return this.#task([`Resizing image: Image resized.`, `resize2fs 1.47.2 (1-Jan-2025)`, `The filesystem on /dev/loop0 is now ${gb * 262144} (4k) blocks long.`, 'TASK OK'], 1200, () => {
			g.diskGb = gb;
			g.config.rootfs = String(g.config.rootfs).replace(/size=\d+G/, `size=${gb}G`);
		});
	}

	async power(vmid: number, action: PowerAction) {
		await delay();
		const g = this.#requireWrite(vmid, 'VM.PowerMgmt');
		const lines: Record<PowerAction, string[]> = {
			start: [`starting CT ${vmid}`, 'TASK OK'],
			stop: [`stopping CT ${vmid}`, 'TASK OK'],
			shutdown: [`shutting down CT ${vmid}`, 'TASK OK'],
			reboot: [`rebooting CT ${vmid}`, 'TASK OK']
		};
		if (action === 'start' && g.status === 'running') throw new ExternalApiError('Proxmox', `CT ${vmid} already running`, 500);
		return this.#task(lines[action], action === 'shutdown' ? 2500 : 1800, () => {
			if (action === 'start' || action === 'reboot') {
				g.status = 'running';
				g.startedAt = Date.now();
			} else g.status = 'stopped';
		});
	}

	async destroy(vmid: number) {
		await delay();
		const g = this.#requireWrite(vmid, 'VM.Allocate');
		if (g.status === 'running') throw new ExternalApiError('Proxmox', `CT ${vmid} is running - destroy failed`, 500);
		if (Number(g.config.protection ?? 0) === 1) throw new ExternalApiError('Proxmox', `can't remove CT ${vmid} - protection mode enabled`, 500);
		return this.#task([`Removing image: 100% complete...done.`, `purging CT ${vmid} from related configurations..`, 'TASK OK'], 1800, () => {
			world().guests.delete(vmid);
		});
	}

	async vzdump(vmid: number, storage: string) {
		await delay();
		const g = this.#requireWrite(vmid, 'VM.Backup');
		const stamp = new Date().toISOString().replace(/[-:]/g, '_').replace('T', '-').slice(0, 19);
		const volid = `${storage}:backup/vzdump-lxc-${vmid}-${stamp}.tar.zst`;
		return this.#task(
			[
				`INFO: starting new backup job: vzdump ${vmid} --mode snapshot --compress zstd --storage ${storage}`,
				`INFO: Starting Backup of VM ${vmid} (lxc)`,
				`INFO: CT Name: ${g.name}`,
				"INFO: mode failure - storage 'local' does not support snapshots, using suspend mode",
				'INFO: starting first sync /proc/12345/root/ to /var/tmp/vzdumptmp',
				'INFO: suspending guest',
				'INFO: resume vm',
				`INFO: creating vzdump archive '/var/lib/vz/dump/vzdump-lxc-${vmid}-${stamp}.tar.zst'`,
				'INFO: Total bytes written: 1309368320 (1.3GiB, 98MiB/s)',
				`INFO: Finished Backup of VM ${vmid} (00:00:14)`,
				'INFO: Backup job finished successfully',
				'TASK OK'
			],
			5500,
			() => world().backups.push({ volid, vmid, ctime: Math.floor(Date.now() / 1000), size: 380 * MiB + Math.floor(Math.random() * 200) * MiB })
		);
	}
}

// =================================================================================
// GitHub
// =================================================================================

function repoOf(owner: string, name: string): FakeRepo {
	const r = world().repos.get(`${owner}/${name}`.toLowerCase());
	if (!r) throw new ExternalApiError('GitHub', `dépôt ${owner}/${name} : Not Found`, 404);
	return r;
}

function labelFromWorkflow(content: string): string {
	const m = content.match(/runs-on:\s*\[self-hosted,\s*([a-z0-9-]+)\]/);
	return m?.[1] ?? 'self-hosted';
}

function runState(r: FakeRun, repo: FakeRepo): { status: string; conclusion: string | null; stepIdx: number; elapsed: number } {
	if (r.startedAt === null) {
		const online = repo.runners.some((x) => x.online && (x.labels.includes(r.runnerLabel) || r.runnerLabel === 'self-hosted'));
		if (online && Date.now() - r.createdAt > 1500) r.startedAt = Date.now();
		else return { status: 'queued', conclusion: null, stepIdx: -1, elapsed: 0 };
	}
	const elapsed = Date.now() - r.startedAt;
	let acc = 0;
	for (let i = 0; i < r.steps.length; i++) {
		acc += r.steps[i]?.durationMs ?? 0;
		if (r.failAtStep === i && elapsed >= acc) return { status: 'completed', conclusion: 'failure', stepIdx: i, elapsed };
		if (elapsed < acc) return { status: 'in_progress', conclusion: null, stepIdx: i, elapsed };
	}
	return { status: 'completed', conclusion: 'success', stepIdx: r.steps.length, elapsed };
}

function toGhRun(r: FakeRun, repo: FakeRepo): GhRun {
	const st = runState(r, repo);
	const total = r.steps.reduce((a, s) => a + s.durationMs, 0);
	return {
		id: r.id,
		runNumber: r.runNumber,
		name: 'Forge · Déploiement',
		status: st.status,
		conclusion: st.conclusion,
		event: r.event,
		headSha: r.headSha,
		headBranch: r.branch,
		commitMessage: r.commitMessage,
		actor: r.actor,
		createdAt: new Date(r.createdAt).toISOString(),
		updatedAt: new Date(st.status === 'completed' && r.startedAt ? r.startedAt + total : Date.now()).toISOString(),
		htmlUrl: `https://github.com/${repo.owner}/${repo.name}/actions/runs/${r.id}`
	};
}

class FakeGithub implements GithubApi {
	async whoami() {
		await delay();
		return { login: 'BastienGRNT', tokenExpiresAt: new Date(Date.now() + 200 * 86400_000).toISOString() };
	}

	async listRepos() {
		await delay(150, 400);
		return [...world().repos.values()]
			.sort((a, b) => b.pushedAt - a.pushedAt)
			.map((r) => ({
				owner: r.owner,
				name: r.name,
				fullName: `${r.owner}/${r.name}`,
				private: r.private,
				defaultBranch: r.defaultBranch,
				description: r.description,
				pushedAt: new Date(r.pushedAt).toISOString(),
				htmlUrl: `https://github.com/${r.owner}/${r.name}`,
				archived: false
			}));
	}

	async getRepo(owner: string, name: string) {
		await delay();
		const r = repoOf(owner, name);
		return {
			owner: r.owner,
			name: r.name,
			fullName: `${r.owner}/${r.name}`,
			private: r.private,
			defaultBranch: r.defaultBranch,
			description: r.description,
			pushedAt: new Date(r.pushedAt).toISOString(),
			htmlUrl: `https://github.com/${r.owner}/${r.name}`,
			archived: false
		};
	}

	async listDir(owner: string, name: string, path: string) {
		await delay();
		const r = repoOf(owner, name);
		const prefix = path ? `${path.replace(/\/+$/, '')}/` : '';
		const seen = new Map<string, 'file' | 'dir'>();
		for (const p of r.files.keys()) {
			if (!p.startsWith(prefix)) continue;
			const rest = p.slice(prefix.length);
			const [head, ...tail] = rest.split('/');
			if (!head) continue;
			seen.set(head, tail.length ? 'dir' : 'file');
		}
		return [...seen.entries()].map(([n, type]) => ({ name: n, path: prefix + n, type }));
	}

	async listTree(owner: string, name: string) {
		await delay();
		const r = repoOf(owner, name);
		const entries = new Map<string, 'file' | 'dir'>();
		for (const p of r.files.keys()) {
			const parts = p.split('/');
			for (let i = 1; i < parts.length; i++) entries.set(parts.slice(0, i).join('/'), 'dir');
			entries.set(p, 'file');
		}
		return { entries: [...entries].map(([path, type]) => ({ path, type })), truncated: false };
	}

	async getFile(owner: string, name: string, path: string) {
		await delay(40, 120);
		const r = repoOf(owner, name);
		const content = r.files.get(path);
		return content === undefined ? null : { content, sha: createHash('sha1').update(content).digest('hex') };
	}

	async listRunners(owner: string, name: string) {
		await delay();
		return repoOf(owner, name).runners.map((x) => ({ id: x.id, name: x.name, status: x.online ? ('online' as const) : ('offline' as const), busy: false, labels: x.labels }));
	}

	async listWorkflowRuns(owner: string, name: string, _file: string, perPage = 20) {
		await delay();
		const r = repoOf(owner, name);
		return [...r.runs].sort((a, b) => b.createdAt - a.createdAt).slice(0, perPage).map((run) => toGhRun(run, r));
	}

	async listRepoRuns(owner: string, name: string, perPage = 5) {
		return this.listWorkflowRuns(owner, name, '', perPage);
	}

	async getRun(owner: string, name: string, runId: number) {
		await delay(40, 100);
		const r = repoOf(owner, name);
		const run = r.runs.find((x) => x.id === runId);
		if (!run) throw new ExternalApiError('GitHub', `run ${runId} : Not Found`, 404);
		return toGhRun(run, r);
	}

	async getRunJobs(owner: string, name: string, runId: number): Promise<GhRunJob[]> {
		await delay(40, 100);
		const r = repoOf(owner, name);
		const run = r.runs.find((x) => x.id === runId);
		if (!run) return [];
		const st = runState(run, r);
		return [
			{
				id: run.id * 10,
				name: `Déployer ${run.runnerLabel}`,
				status: st.status,
				conclusion: st.conclusion,
				startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null,
				completedAt: st.status === 'completed' ? new Date().toISOString() : null,
				steps: run.steps.map((s, i) => {
					let status = 'queued';
					let conclusion: string | null = null;
					if (s.skipped && (st.status === 'completed' || i <= st.stepIdx)) {
						status = 'completed';
						conclusion = 'skipped';
					} else if (st.status === 'completed') {
						status = 'completed';
						conclusion = st.conclusion === 'failure' ? (i < st.stepIdx ? 'success' : i === st.stepIdx ? 'failure' : 'skipped') : 'success';
					} else if (i < st.stepIdx) {
						status = 'completed';
						conclusion = 'success';
					} else if (i === st.stepIdx) status = 'in_progress';
					return { number: i + 1, name: s.name, status, conclusion };
				})
			}
		];
	}

	async getJobLogs(owner: string, name: string, jobId: number) {
		await delay();
		const r = repoOf(owner, name);
		const run = r.runs.find((x) => x.id * 10 === jobId);
		const t0 = run?.startedAt ?? Date.now();
		const ts = (ms: number) => new Date(t0 + ms).toISOString();
		const lines = [
			`${ts(0)} Current runner version: '2.338.0'`,
			`${ts(10)} Runner name: '${run?.runnerLabel}'`,
			`${ts(1300)} ##[group]Run actions/checkout@v7`,
			`${ts(2600)} Syncing repository: ${owner}/${name}`,
			`${ts(3200)} ##[group]Run set -euo pipefail`,
			`${ts(3900)} ##[group]Run docker compose -f "$FORGE_COMPOSE_FILE" up -d --build --remove-orphans`,
			`${ts(4100)} #1 [internal] load build definition from Dockerfile`,
			`${ts(5200)} #8 [build 4/6] RUN npm ci`,
			`${ts(8700)} #12 exporting to image`,
			`${ts(9400)}  Container ${name}-db-1  Running`,
			`${ts(9800)}  Container ${name}-app-1  Recreated`,
			`${ts(10300)}  Container ${name}-app-1  Started`
		];
		if (run?.failAtStep !== null && run?.failAtStep !== undefined) {
			lines.push(`${ts(10400)} ERROR: failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1`);
			lines.push(`${ts(10450)} ##[error]Process completed with exit code 1.`);
		} else {
			lines.push(`${ts(10900)} ##[group]Run docker image prune -f`, `${ts(11200)} Total reclaimed space: 312.4MB`);
		}
		return lines.join('\n');
	}

	async getPublicKey(owner: string, name: string) {
		await delay();
		repoOf(owner, name);
		const w = world();
		if (!w.ghKeyPair) w.ghKeyPair = await generateBoxKeyPair();
		return { keyId: '3380204578043523366', key: w.ghKeyPair.publicKey };
	}

	async listVariables(owner: string, name: string) {
		await delay();
		return [...repoOf(owner, name).variables.entries()].map(([n, value]) => ({ name: n, value }));
	}

	async latestCommit(owner: string, name: string, branch: string) {
		await delay();
		if (`${owner}/${name}`.toLowerCase() === 'bastiengrnt/crystal_forge') {
			const sha = createHash('sha1').update(`forge-${Math.floor(world().createdAt / 1000)}`).digest('hex');
			return { sha, message: 'fix: vérification HTTPS via NPM (démo)', date: new Date(world().createdAt).toISOString() };
		}
		const r = repoOf(owner, name);
		return { sha: createHash('sha1').update(`${r.name}-${r.commits}`).digest('hex'), message: `dernier commit de ${branch}`, date: new Date(r.pushedAt).toISOString() };
	}

	async downloadTarball() {
		await delay(300, 600);
		return gzipSync(Buffer.from('archive simulée'));
	}

	async createRegistrationToken(owner: string, name: string) {
		await delay();
		repoOf(owner, name);
		return { token: 'A' + randomBytes(16).toString('hex').toUpperCase().slice(0, 28), expiresAt: new Date(Date.now() + 3600_000).toISOString() };
	}

	async deleteRunner(owner: string, name: string, runnerId: number) {
		await delay();
		const r = repoOf(owner, name);
		r.runners = r.runners.filter((x) => x.id !== runnerId);
	}

	async putSecret(owner: string, name: string, secret: string) {
		await delay();
		repoOf(owner, name).secrets.set(secret, Date.now());
	}

	async deleteSecret(owner: string, name: string, secret: string) {
		await delay();
		repoOf(owner, name).secrets.delete(secret);
	}

	async setVariable(owner: string, name: string, variable: string, value: string) {
		await delay(40, 120);
		const r = repoOf(owner, name);
		const existed = r.variables.has(variable);
		r.variables.set(variable, value);
		return existed ? ('updated' as const) : ('created' as const);
	}

	async deleteVariable(owner: string, name: string, variable: string) {
		await delay(40, 120);
		repoOf(owner, name).variables.delete(variable);
	}

	#newRun(r: FakeRepo, event: string, message: string): FakeRun {
		const w = world();
		const wf = r.files.get('.github/workflows/forge-deploy.yml') ?? '';
		const run: FakeRun = {
			id: w.nextRunId++,
			runNumber: r.runs.length + 1,
			repo: r.name,
			event,
			headSha: createHash('sha1').update(`${r.name}-${r.commits}`).digest('hex'),
			branch: r.defaultBranch,
			commitMessage: message,
			actor: 'BastienGRNT',
			createdAt: Date.now(),
			startedAt: null,
			steps: runSteps(r.variables),
			failAtStep: null,
			runnerLabel: labelFromWorkflow(wf)
		};
		r.runs.push(run);
		return run;
	}

	async createFile(owner: string, name: string, path: string, content: string, message: string, branch: string) {
		await delay(200, 500);
		const r = repoOf(owner, name);
		if (r.files.has(path)) throw new ExternalApiError('GitHub', `Invalid request. "sha" wasn't supplied.`, 422);
		r.files.set(path, content);
		r.commits++;
		r.pushedAt = Date.now();
		const commitSha = createHash('sha1').update(`${r.name}-${r.commits}`).digest('hex');
		// Comme sur GitHub, le commit du workflow déclenche un run « push ».
		if (path === '.github/workflows/forge-deploy.yml' && branch === r.defaultBranch) this.#newRun(r, 'push', message);
		return { commitSha, contentSha: createHash('sha1').update(content).digest('hex') };
	}

	async updateFile(owner: string, name: string, path: string, content: string, message: string, branch: string, sha: string) {
		await delay(200, 500);
		const r = repoOf(owner, name);
		const current = r.files.get(path);
		if (current === undefined) throw new ExternalApiError('GitHub', `${path} introuvable`, 404);
		if (createHash('sha1').update(current).digest('hex') !== sha) throw new ExternalApiError('GitHub', `${path} does not match ${sha}`, 409);
		r.files.set(path, content);
		r.commits++;
		r.pushedAt = Date.now();
		const commitSha = createHash('sha1').update(`${r.name}-${r.commits}`).digest('hex');
		if (path === '.github/workflows/forge-deploy.yml' && branch === r.defaultBranch && !message.includes('[skip ci]')) this.#newRun(r, 'push', message);
		return { commitSha, contentSha: createHash('sha1').update(content).digest('hex') };
	}

	async deleteFile(owner: string, name: string, path: string) {
		await delay();
		const r = repoOf(owner, name);
		r.files.delete(path);
		r.commits++;
	}

	async dispatchWorkflow(owner: string, name: string, file: string) {
		await delay(200, 400);
		const r = repoOf(owner, name);
		if (!r.files.has(`.github/workflows/${file}`)) throw new ExternalApiError('GitHub', `Workflow ${file} introuvable sur ${r.defaultBranch}`, 404);
		const run = this.#newRun(r, 'workflow_dispatch', 'Déploiement manuel (Forge)');
		return { runId: run.id, htmlUrl: `https://github.com/${r.owner}/${r.name}/actions/runs/${run.id}` };
	}
}

// =================================================================================
// OVH
// =================================================================================

class FakeOvh implements OvhApi {
	#zone(zone: string) {
		const z = world().zones.get(zone);
		if (!z) throw new ExternalApiError('OVH', `GET /domain/zone/${zone} : HTTP 404 This service does not exist`, 404);
		return z;
	}

	async currentCredential() {
		await delay();
		const rules = [
			{ method: 'GET', path: '/domain/zone' },
			{ method: 'GET', path: '/auth/currentCredential' }
		];
		for (const z of world().zones.keys()) {
			rules.push(
				{ method: 'GET', path: `/domain/zone/${z}/record` },
				{ method: 'GET', path: `/domain/zone/${z}/record/*` },
				{ method: 'POST', path: `/domain/zone/${z}/record` },
				{ method: 'POST', path: `/domain/zone/${z}/refresh` },
				{ method: 'DELETE', path: `/domain/zone/${z}/record/*` }
			);
		}
		return { status: 'validated', applicationId: 271828, expiration: null, rules };
	}

	async listZones() {
		await delay();
		return [...world().zones.keys()];
	}

	async listRecordIds(zone: string, filter: { subDomain?: string; fieldType?: string } = {}) {
		await delay();
		return this.#zone(zone)
			.filter((r) => (filter.subDomain === undefined || r.subDomain === filter.subDomain) && (!filter.fieldType || r.fieldType === filter.fieldType))
			.map((r) => r.id);
	}

	async getRecord(zone: string, id: number) {
		await delay(20, 60);
		const r = this.#zone(zone).find((x) => x.id === id);
		if (!r) throw new ExternalApiError('OVH', `record ${id} : HTTP 404`, 404);
		return { id: r.id, zone: r.zone, fieldType: r.fieldType, subDomain: r.subDomain, target: r.target, ttl: r.ttl };
	}

	async createRecord(zone: string, rec: { fieldType: string; subDomain: string; target: string; ttl: number }) {
		await delay(150, 350);
		const w = world();
		const r = { id: w.nextRecordId++, zone, ...rec, visibleAt: Date.now() + 6000 };
		this.#zone(zone).push(r);
		return { id: r.id, zone, fieldType: r.fieldType, subDomain: r.subDomain, target: r.target, ttl: r.ttl };
	}

	async refreshZone(zone: string) {
		await delay(100, 250);
		this.#zone(zone);
	}

	async deleteRecord(zone: string, id: number) {
		await delay();
		const z = this.#zone(zone);
		const idx = z.findIndex((r) => r.id === id);
		if (idx >= 0) z.splice(idx, 1);
	}
}

// =================================================================================
// Nginx Proxy Manager
// =================================================================================

function publiclyResolves(fqdn: string): boolean {
	for (const [zone, records] of world().zones) {
		const sub = fqdn === zone ? '' : fqdn.endsWith(`.${zone}`) ? fqdn.slice(0, -(zone.length + 1)) : null;
		if (sub === null) continue;
		return records.some((r) => r.fieldType === 'A' && r.subDomain === sub && r.visibleAt <= Date.now());
	}
	return false;
}

class FakeNpm implements NpmApi {
	#toHost(h: FakeNpmHost): NpmProxyHost {
		const cert = world().npmCerts.find((c) => c.id === h.certificateId);
		return {
			id: h.id,
			domainNames: h.domainNames,
			forwardScheme: 'http',
			forwardHost: h.forwardHost,
			forwardPort: h.forwardPort,
			certificateId: h.certificateId,
			sslForced: true,
			enabled: true,
			nginxOnline: true,
			nginxError: null,
			certificate: cert ? { id: cert.id, expiresOn: cert.expiresOn, provider: 'letsencrypt' } : null
		};
	}

	async health() {
		await delay();
		return { status: 'OK', version: '2.16.0' };
	}

	async me() {
		await delay();
		return {
			id: 3,
			email: 'forge@bastiengrnt.fr',
			name: 'Forge',
			roles: [],
			permissions: { visibility: 'all', proxy_hosts: 'manage', redirection_hosts: 'hidden', dead_hosts: 'hidden', streams: 'hidden', access_lists: 'hidden', certificates: 'manage' }
		};
	}

	async listProxyHosts() {
		await delay();
		return world().npmHosts.map((h) => this.#toHost(h));
	}

	async listCertificates() {
		await delay();
		return world().npmCerts.map((c) => ({ id: c.id, niceName: c.domainNames[0] ?? '', domainNames: c.domainNames, expiresOn: c.expiresOn, provider: 'letsencrypt' }));
	}

	async createProxyHost(p: NpmCreateProxyHost) {
		await delay(2500, 4000); // certbot
		const w = world();
		for (const d of p.domain_names) {
			if (w.npmHosts.some((h) => h.domainNames.includes(d))) throw new ExternalApiError('NPM', `POST /nginx/proxy-hosts : HTTP 400 ${d} is already in use`, 400);
			if (!publiclyResolves(d)) {
				throw new ExternalApiError(
					'NPM',
					`POST /nginx/proxy-hosts : HTTP 500 Command failed: certbot certonly … Certbot failed to authenticate some domains. Domain: ${d} — Detail: DNS problem: NXDOMAIN looking up A for ${d}`,
					500
				);
			}
		}
		const reused = typeof p.certificate_id === 'number' ? w.npmCerts.find((c) => c.id === p.certificate_id) : undefined;
		if (typeof p.certificate_id === 'number' && !reused) throw new ExternalApiError('NPM', `POST /nginx/proxy-hosts : HTTP 400 Certificate ${p.certificate_id} not found`, 400);
		const certId = reused?.id ?? w.nextNpmId++;
		if (!reused) w.npmCerts.push({ id: certId, domainNames: p.domain_names, expiresOn: new Date(Date.now() + 90 * 86400_000).toISOString().replace('T', ' ').slice(0, 19) });
		const host = { id: w.nextNpmId++, domainNames: p.domain_names, forwardHost: p.forward_host, forwardPort: p.forward_port, certificateId: certId };
		w.npmHosts.push(host);
		return this.#toHost(host);
	}

	async updateProxyHost(id: number, patch: { forward_host: string; forward_port: number }) {
		await delay();
		const host = world().npmHosts.find((h) => h.id === id);
		if (!host) throw new ExternalApiError('NPM', `PUT /nginx/proxy-hosts/${id} : HTTP 404 Not Found`, 404);
		host.forwardHost = patch.forward_host;
		host.forwardPort = patch.forward_port;
		return this.#toHost(host);
	}

	async deleteProxyHost(id: number) {
		await delay();
		const w = world();
		w.npmHosts = w.npmHosts.filter((h) => h.id !== id);
	}

	async deleteCertificate(id: number) {
		await delay();
		const w = world();
		w.npmCerts = w.npmCerts.filter((c) => c.id !== id);
	}
}

// =================================================================================
// SSH
// =================================================================================

class FakeSsh implements SshApi {
	async exec(target: SshTarget, command: string, opts: { onOutput?: (chunk: string) => void; stdin?: Buffer } = {}): Promise<SshResult> {
		await delay(150, 400);
		const g = guestByIp(target.host);
		if (!sshReady(g)) throw new ExternalApiError('SSH', `${target.user}@${target.host} : connect ECONNREFUSED ${target.host}:22`);
		const guest = g as FakeGuest;
		const hostKey = 'SHA256:' + createHash('sha256').update(`hostkey-${guest.vmid}-${guest.startedAt > 0 ? 'v1' : ''}`).digest('base64').replace(/=+$/, '');
		if (target.expectedHostKey && target.expectedHostKey !== hostKey) {
			throw new ExternalApiError('SSH', `la clé d'hôte de ${target.host} a changé : connexion refusée`);
		}
		const out: string[] = [];
		const emit = async (s: string, ms = 120) => {
			out.push(s);
			opts.onOutput?.(s);
			await delay(ms * 0.5, ms * 1.5);
		};

		if (command === 'true') return { code: 0, stdout: '', stderr: '', hostKey };

		const dbOp = /^: forge-(?:db|op)=([a-z]+);/.exec(command)?.[1];
		if (dbOp) return { ...(await fakeDbCommand(guest, dbOp, command, opts.stdin)), hostKey };
		if (command.includes('systemctl enable --now unattended-upgrades')) {
			await emit('Reading package lists...\nunattended-upgrades is already the newest version (2.9.1+nmu4ubuntu1).\nenabled\n', 600);
			world().unattended.add(guest.vmid);
			return { code: 0, stdout: out.join(''), stderr: '', hostKey };
		}

		if (command.includes('config.sh')) {
			const name = command.match(/--name\s+'?([a-z0-9-]+)/)?.[1] ?? guest.name;
			const url = command.match(/--url\s+'?https:\/\/github\.com\/([^/'\s]+)\/([^'\s]+)/);
			const repoName = url?.[2] ?? '';
			await emit('\n--------------------------------------------------------------------------------\n|        ____ _ _   _   _       _          _        _   _                      |\n|       / ___(_) |_| | | |_   _| |__      / \\   ___| |_(_) ___  _ __  ___      |\n--------------------------------------------------------------------------------\n');
			await emit('\n# Authentication\n\n√ Connected to GitHub\n', 400);
			await emit('\n# Runner Registration\n\n√ Runner successfully added\n', 500);
			await emit('√ Runner connection is good\n\n# Runner settings\n\n√ Settings Saved.\n', 300);
			const r = world().repos.get(`${url?.[1] ?? ''}/${repoName}`.toLowerCase());
			if (r && !r.runners.some((x) => x.name === name)) {
				r.runners.push({ id: world().nextRunnerId++, name, labels: ['self-hosted', 'Linux', 'X64', 'forge', name], online: false });
			}
			return { code: 0, stdout: out.join(''), stderr: '', hostKey };
		}

		if (command.includes('svc.sh')) {
			await emit(`Creating launch runner in /etc/systemd/system/actions.runner.BastienGRNT-${guest.name}.${guest.name}.service\nRun as user: github\nRun as uid: 1000\ngid: 1000\n`, 400);
			await emit(`Created symlink /etc/systemd/system/multi-user.target.wants/actions.runner.BastienGRNT-${guest.name}.${guest.name}.service\n`, 300);
			await emit(`\n● actions.runner.BastienGRNT-${guest.name}.${guest.name}.service - GitHub Actions Runner\n     Active: active (running)\n`, 300);
			setTimeout(() => {
				for (const r of world().repos.values()) for (const x of r.runners) if (x.name === guest.name) x.online = true;
			}, 2500);
			return { code: 0, stdout: out.join(''), stderr: '', hostKey };
		}

		if (command.includes('docker compose') && command.includes(' ps ')) {
			const base = guest.name.replace(/-/g, '');
			const started = new Date(Date.now() - 3600_000 * 5).toISOString();
			const rows = [
				{ Name: `${base}-app-1`, Service: 'app', State: 'running', Status: 'Up 5 hours', Health: '', Publishers: [{ URL: '0.0.0.0', TargetPort: 3000, PublishedPort: 3000, Protocol: 'tcp' }], CreatedAt: started, Image: `${base}-app` },
				{ Name: `${base}-db-1`, Service: 'db', State: 'running', Status: 'Up 5 days (healthy)', Health: 'healthy', Publishers: [], CreatedAt: started, Image: 'postgres:17' }
			];
			return { code: 0, stdout: rows.map((r) => JSON.stringify(r)).join('\n') + '\n', stderr: '', hostKey };
		}

		if (command.includes('docker compose') && command.includes(' logs ')) {
			const now = Date.now();
			const lines: string[] = [];
			const svcMatch = command.match(/--tail \d+ ([a-zA-Z0-9_.-]+)$/);
			const services = svcMatch ? [svcMatch[1]] : ['app', 'db'];
			for (let i = 40; i > 0; i--) {
				const t = new Date(now - i * 47_000).toISOString();
				const svc = services[i % services.length];
				if (svc === 'db') lines.push(`db-1   | ${t} 2026-10-14 ${t.slice(11, 19)}.123 UTC [${2000 + i}] LOG:  checkpoint complete: wrote ${i * 3} buffers`);
				else lines.push(`app-1  | ${t} ${['GET', 'POST'][i % 2]} /${['', 'api/notes', 'api/search?q=forge', 'login'][i % 4]} ${[200, 200, 304, 201][i % 4]} ${(i * 7) % 90 + 3}ms`);
			}
			return { code: 0, stdout: lines.join('\n') + '\n', stderr: '', hostKey };
		}

		if (command.startsWith('df ')) {
			return { code: 0, stdout: `${guest.diskGb * GiB} ${Math.round(guest.diskUsedGb * GiB)} ${Math.round((guest.diskGb - guest.diskUsedGb) * GiB)}\n`, stderr: '', hostKey };
		}

		return { code: 0, stdout: '', stderr: '', hostKey };
	}
}

// --- Bases de données simulées ---------------------------------------------------------

function csvCell(v: string): string {
	return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function fakeOutput(postgres: boolean, columns: string[], rows: string[][]): string {
	if (postgres) return [columns, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
	const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
	return [columns, ...rows].map((r) => r.map(esc).join('\t')).join('\n') + '\n';
}

function fakeDb(guest: FakeGuest): FakeTable[] {
	const w = world();
	let db = w.databases.get(guest.name);
	if (!db) {
		db = demoTables(guest.name);
		w.databases.set(guest.name, db);
	}
	return db;
}

const ok = (stdout: string) => ({ code: 0, stdout, stderr: '__FORGE_RC=0\n' });
const sqlError = (msg: string) => ({ code: 0, stdout: '', stderr: `${msg}\n__FORGE_RC=1\n` });

async function fakeDbCommand(guest: FakeGuest, op: string, command: string, stdin?: Buffer): Promise<{ code: number; stdout: string; stderr: string }> {
	const w = world();
	const slug = /forge-backups\/([a-z0-9-]+)/.exec(command)?.[1] ?? guest.name;
	const backups = w.dbBackups.get(slug) ?? [];
	w.dbBackups.set(slug, backups);

	if (op === 'list') {
		return { code: 0, stdout: backups.map((b) => `${b.name}\t${b.size}\t${(b.mtime / 1000).toFixed(3)}`).join('\n') + (backups.length ? '\n' : ''), stderr: '' };
	}
	if (op === 'inspect') return { code: 0, stdout: 'running 172.18.0.2 \n', stderr: '' };
	if (op === 'backup') {
		await delay(900, 1600);
		const name = /forge-backups\/[a-z0-9-]+\/([^'/]+\.sql\.gz)\.part/.exec(command)?.[1];
		if (!name) return { code: 1, stdout: '', stderr: 'nom de fichier introuvable' };
		const size = 40_000 + Math.round(Math.random() * 12_000);
		backups.unshift({ name, size, mtime: Date.now() });
		return { code: 0, stdout: `${size}\n`, stderr: '' };
	}
	if (op === 'import') {
		await delay(400, 900);
		const name = /forge-backups\/[a-z0-9-]+\/([^'/]+\.sql\.gz)\.part/.exec(command)?.[1];
		if (!name || !stdin) return { code: 1, stdout: '', stderr: 'fichier manquant' };
		backups.unshift({ name, size: stdin.length, mtime: Date.now() });
		return { code: 0, stdout: `${stdin.length}\n`, stderr: '' };
	}
	if (op === 'internet') return { code: 0, stdout: '200', stderr: '' };
	if (op === 'versions') {
		return { code: 0, stdout: `docker=28.5.1\nunattended=${w.unattended.has(guest.vmid) ? 'enabled' : 'disabled'}\nos=Ubuntu 24.04.3 LTS\n`, stderr: '' };
	}
	if (op === 'restore') {
		await delay(1500, 2500);
		return { code: 0, stdout: '', stderr: '' };
	}
	if (op === 'download') {
		const name = /forge-backups\/[a-z0-9-]+\/([^']+\.sql\.gz)/.exec(command)?.[1];
		if (!backups.some((b) => b.name === name)) return { code: 1, stdout: '', stderr: `stat: cannot statx '${name}': No such file or directory` };
		const tables = fakeDb(guest);
		const sql = `-- Dump simulé par le mode démo de Forge (${name})\n` + tables.map((t) => `CREATE TABLE ${t.schema}.${t.name} (${t.columns.join(' text, ')} text);\n-- ${t.rows.length} lignes`).join('\n') + '\n';
		const gz = gzipSync(Buffer.from(sql));
		return { code: 0, stdout: `${gz.length}\n${gz.toString('base64')}`, stderr: '' };
	}
	if (op !== 'query') return { code: 0, stdout: '', stderr: '' };

	await delay(80, 250);
	const b64 = /printf %s '([A-Za-z0-9+/=]*)'/.exec(command)?.[1] ?? '';
	const sql = Buffer.from(b64, 'base64').toString('utf8').trim();
	const postgres = command.includes('psql');
	const readOnly = command.includes('default_transaction_read_only=on') || command.includes('READ ONLY');
	const tables = fakeDb(guest);
	const lower = sql.toLowerCase();

	if (lower.includes("current_setting('server_version')") || lower.includes('version()')) {
		const bytes = 8_400_000 + tables.reduce((a, t) => a + t.rows.length * 220, 0);
		return ok(fakeOutput(postgres, ['version', 'database', 'user', 'bytes'], [[postgres ? '17.6' : '11.8.3-MariaDB', 'app', 'app', String(bytes)]]));
	}
	if (lower.includes('pg_class') || lower.includes('information_schema.tables')) {
		return ok(fakeOutput(postgres, ['schema', 'name', 'rows', 'bytes'], tables.map((t) => [t.schema, t.name, String(t.rows.length), String(16384 + t.rows.length * 180)])));
	}

	const first = /^[a-z]+/.exec(lower)?.[0] ?? '';
	if (['insert', 'update', 'delete', 'create', 'drop', 'alter', 'truncate'].includes(first)) {
		if (readOnly) return sqlError('ERROR:  cannot execute ' + first.toUpperCase() + ' in a read-only transaction');
		const target = /(?:into|update|from|table)\s+(?:"?(\w+)"?\.)?"?(\w+)"?/i.exec(sql);
		const t = tables.find((x) => x.name === target?.[2]);
		if (!t && first !== 'create') return sqlError(`ERROR:  relation "${target?.[2] ?? '?'}" does not exist`);
		if (t && (first === 'delete' || first === 'truncate') && !/\bwhere\b/i.test(sql)) t.rows = [];
		return ok('');
	}

	const from = /\bfrom\s+(?:"?(\w+)"?\.)?"?(\w+)"?/i.exec(sql);
	if (!from) {
		return ok(fakeOutput(postgres, ['?column?'], [['1']]));
	}
	const t = tables.find((x) => x.name === from[2] && (!from[1] || x.schema === from[1]));
	if (!t) return sqlError(`ERROR:  relation "${from[1] ? `${from[1]}.` : ''}${from[2]}" does not exist\nLINE 1: ${sql.slice(0, 80)}`);
	if (/count\(\*\)/i.test(sql)) return ok(fakeOutput(postgres, ['count'], [[String(t.rows.length)]]));
	const limit = Number(/\blimit\s+(\d+)/i.exec(sql)?.[1] ?? 1000);
	const offset = Number(/\boffset\s+(\d+)/i.exec(sql)?.[1] ?? 0);
	let rows = t.rows;
	const where = /\bwhere\s+"?(\w+)"?\s*=\s*'?([^'\s;]+)'?/i.exec(sql);
	if (where) {
		const idx = t.columns.indexOf(where[1] as string);
		if (idx >= 0) rows = rows.filter((r) => r[idx] === where[2]);
	}
	if (/order\s+by\s+"?id"?\s+desc/i.test(sql)) rows = [...rows].reverse();
	return ok(fakeOutput(postgres, t.columns, rows.slice(offset, offset + limit)));
}

// =================================================================================
// Sondes & DNS public
// =================================================================================

class FakeProbe implements ProbeApi {
	async ping(ip: string) {
		await delay(20, 80);
		return ip === '10.10.10.1' || world().ghostIps.has(ip) || !!guestByIp(ip)?.status.startsWith('running');
	}
	async arpHas(ip: string) {
		return this.ping(ip);
	}
	async tcpOpen(host: string, port: number) {
		await delay(30, 120);
		if (port === 22) return sshReady(guestByIp(host));
		return !!guestByIp(host);
	}
	async http(url: string) {
		const start = Date.now();
		await delay(80, 300);
		const host = new URL(url).hostname;
		const h = world().npmHosts.find((x) => x.domainNames.includes(host));
		if (!h) return { ok: false, status: null, error: 'ENOTFOUND', ms: Date.now() - start };
		const g = guestByIp(h.forwardHost);
		const up = !g || g.status === 'running';
		return { ok: up, status: up ? 200 : 502, error: null, ms: Date.now() - start };
	}
}

class FakeResolver implements ResolverApi {
	async resolveA(name: string) {
		await delay(60, 150);
		for (const [zone, records] of world().zones) {
			const sub = name === zone ? '' : name.endsWith(`.${zone}`) ? name.slice(0, -(zone.length + 1)) : null;
			if (sub === null) continue;
			return records.filter((r) => r.fieldType === 'A' && r.subDomain === sub && r.visibleAt <= Date.now()).map((r) => r.target);
		}
		return [];
	}
}

export function createFakeApis(): ExternalApis {
	return {
		proxmox: new FakeProxmox(),
		github: new FakeGithub(),
		ovh: new FakeOvh(),
		npm: new FakeNpm(),
		ssh: new FakeSsh(),
		probe: new FakeProbe(),
		resolver: new FakeResolver()
	};
}

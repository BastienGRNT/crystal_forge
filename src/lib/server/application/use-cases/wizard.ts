/** Assistant « Nouveau projet » : lectures pour préremplir et valider le formulaire. */
import { candidateIps, nextFreeCtid } from '$lib/domain/allocation';
import { detectDeployMode, normalizeWorkdir, repoPath, type DetectionResult } from '$lib/domain/compose-detect';
import { analyzeCompose, type ComposeAnalysis } from '$lib/domain/compose-analysis';
import { ENV_TEMPLATE_FILES, parseEnvTemplate, type EnvTemplate } from '$lib/domain/env-template';
import { buildFqdn, isValidSubdomain, normalizeSubdomain } from '$lib/domain/domain-name';
import { errorMessage } from '$lib/domain/errors';
import { assessHostRam, SIZES, type SizeKey } from '$lib/domain/sizes';
import { findSelfHostedWorkflows, WORKFLOW_PATH, type SelfHostedUsage } from '$lib/domain/workflow';
import type { GhRepo } from '../ports';
import type { ForgeServices } from '../services';

export interface RepoInspection {
	repo: GhRepo;
	workdir: string;
	detection: DetectionResult;
	subdirs: { path: string; detection: DetectionResult }[];
	selfHosted: SelfHostedUsage[];
	hasForgeWorkflow: boolean;
	linkedProject: string | null;
	composeServices: string[];
	compose: ComposeAnalysis | null;
	envTemplate: EnvTemplate | null;
}

const SKIP_DIRS = new Set(['.github', 'node_modules', '.git', 'docs', 'doc', '.vscode', '.idea', 'test', 'tests', 'scripts']);

export class WizardService {
	#repos: { at: number; list: GhRepo[] } | null = null;

	constructor(private readonly s: ForgeServices) {}

	async listRepos(force = false): Promise<GhRepo[]> {
		if (!force && this.#repos && Date.now() - this.#repos.at < 60_000) return this.#repos.list;
		const list = (await this.s.github.api.listRepos()).filter((r) => !r.archived);
		this.#repos = { at: Date.now(), list };
		return list;
	}

	async inspect(fullName: string, workdirInput?: string): Promise<RepoInspection> {
		const [owner, name] = fullName.split('/') as [string, string];
		const api = this.s.github.api;
		const repo = await api.getRepo(owner, name);
		const workdir = normalizeWorkdir(workdirInput);
		const branch = repo.defaultBranch;

		const root = await api.listDir(owner, name, '', branch);
		const here = workdir === '.' ? root : await api.listDir(owner, name, workdir, branch);
		const detection = detectDeployMode(here.filter((e) => e.type === 'file').map((e) => e.name));

		// Sous-dossiers candidats (un niveau) contenant un compose ou un Dockerfile.
		const dirs = root.filter((e) => e.type === 'dir' && !SKIP_DIRS.has(e.name)).slice(0, 15);
		const subdirs = (
			await Promise.all(
				dirs.map(async (d) => {
					const entries = await api.listDir(owner, name, d.path, branch).catch(() => []);
					return { path: d.path, detection: detectDeployMode(entries.filter((e) => e.type === 'file').map((e) => e.name)) };
				})
			)
		).filter((x) => x.detection.supported);

		const wfEntries = await api.listDir(owner, name, '.github/workflows', branch);
		const wfFiles = await Promise.all(
			wfEntries
				.filter((e) => e.type === 'file' && /\.ya?ml$/.test(e.name))
				.map(async (e) => ({ path: e.path, content: (await api.getFile(owner, name, e.path, branch))?.content ?? '' }))
		);

		let compose: ComposeAnalysis | null = null;
		if (detection.mode === 'compose' && detection.file) {
			const content = (await api.getFile(owner, name, repoPath(workdir, detection.file), branch))?.content ?? '';
			compose = analyzeCompose(content);
		}
		const envTemplate = await findEnvTemplate(api, owner, name, workdir, branch, here.map((e) => e.name));

		const linked = this.s.repos.projects.list().find((p) => `${p.repoOwner}/${p.repoName}`.toLowerCase() === fullName.toLowerCase());
		return {
			repo,
			workdir,
			detection,
			subdirs,
			selfHosted: findSelfHostedWorkflows(wfFiles),
			hasForgeWorkflow: wfFiles.some((f) => f.path === WORKFLOW_PATH),
			linkedProject: linked?.slug ?? null,
			composeServices: compose?.services.map((x) => x.name) ?? [],
			compose,
			envTemplate
		};
	}

	async zones(): Promise<{ zones: string[]; error: string | null }> {
		try {
			return { zones: await this.s.dns.listZones(), error: null };
		} catch (err) {
			return { zones: [], error: errorMessage(err) };
		}
	}

	/** Disponibilité d'un nom : base Forge, NPM et DNS OVH. */
	async checkDomain(subdomain: string, zone: string, managed: boolean) {
		const sub = normalizeSubdomain(subdomain);
		if (!isValidSubdomain(sub)) return { fqdn: '', ok: false, reasons: ['Sous-domaine invalide'] };
		const fqdn = buildFqdn(sub, zone);
		const reasons: string[] = [];
		const warnings: string[] = [];
		if (this.s.repos.domains.byFqdn(fqdn)) reasons.push('Déjà utilisé par un projet Forge');
		try {
			const hosts = await this.s.proxy.listHosts();
			const h = hosts.find((x) => x.domainNames.includes(fqdn));
			if (h) reasons.push(`Proxy host NPM existant → ${h.forwardHost}:${h.forwardPort}`);
		} catch (err) {
			warnings.push(`NPM : ${errorMessage(err)}`);
		}
		if (managed) {
			try {
				const records = await this.s.dns.recordsFor(zone, sub);
				const publicIp = this.s.settings.get('network.publicIp');
				for (const r of records.filter((x) => ['A', 'AAAA', 'CNAME'].includes(x.fieldType))) {
					if (r.fieldType === 'A' && r.target === publicIp) warnings.push(`Un A → ${publicIp} existe déjà (sera réutilisé)`);
					else reasons.push(`Enregistrement ${r.fieldType} existant → ${r.target}`);
				}
			} catch (err) {
				warnings.push(`OVH : ${errorMessage(err)}`);
			}
		}
		return { fqdn, ok: reasons.length === 0, reasons, warnings };
	}

	/** Prochain CTID / IP probables et impact RAM (sans ping : indicatif). */
	async preview(size: SizeKey) {
		const { proxmox, settings, repos } = this.s;
		const [node, guests] = await Promise.all([proxmox.nodeStatus(), proxmox.guests()]);
		const used = await proxmox.usedIps(guests);
		const reserved = repos.projects.reservedAllocations();
		const ctid = nextFreeCtid(
			guests.map((g) => g.vmid),
			{ min: settings.int('ctid.min'), max: settings.int('ctid.max') },
			[...reserved.ctids, ...settings.safetyContext().protectedCtids]
		);
		const ips = candidateIps(
			[...used.map((u) => u.ip), ...reserved.ips],
			{ start: settings.get('network.ipStart'), end: settings.get('network.ipEnd') },
			settings.list('network.reservedIps')
		);
		const ram = assessHostRam(node.memory.total / 1024 ** 2, node.memory.used / 1024 ** 2, SIZES[size]);
		return { ctid, ip: ips[0] ?? null, freeIps: ips.length, ram, memTotalMb: node.memory.total / 1024 ** 2 };
	}
}

/** Premier modèle de .env trouvé dans le dossier de travail (puis à la racine). */
export async function findEnvTemplate(
	api: ForgeServices['github']['api'],
	owner: string,
	repo: string,
	workdir: string,
	branch: string,
	names?: string[]
): Promise<EnvTemplate | null> {
	const dirs = workdir === '.' ? ['.'] : [workdir, '.'];
	for (const dir of dirs) {
		const listing = dir === workdir && names ? names : (await api.listDir(owner, repo, dir === '.' ? '' : dir, branch).catch(() => [])).map((e) => e.name);
		const file = ENV_TEMPLATE_FILES.find((f) => listing.includes(f));
		if (!file) continue;
		const path = repoPath(dir, file);
		const content = (await api.getFile(owner, repo, path, branch))?.content;
		if (content !== undefined) return parseEnvTemplate(path, content);
	}
	return null;
}

/** Noms des services d'un docker-compose (lecture légère, sans dépendre du schéma complet). */
export function parseComposeServices(content: string): string[] {
	const lines = content.split('\n');
	const out: string[] = [];
	let inServices = false;
	let indent = -1;
	for (const line of lines) {
		if (/^services:\s*$/.test(line)) {
			inServices = true;
			continue;
		}
		if (inServices) {
			if (/^\S/.test(line) && line.trim() !== '') break;
			const m = /^(\s+)([A-Za-z0-9_.-]+):\s*$/.exec(line);
			if (m) {
				const len = (m[1] ?? '').length;
				if (indent === -1) indent = len;
				if (len === indent) out.push(m[2] as string);
			}
		}
	}
	return out;
}

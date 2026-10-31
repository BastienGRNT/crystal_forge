/** Cas d'usage sur les projets : création + déploiement, .env, domaines, conteneur, suppression. */
import { detectDeployMode, isValidServiceName, normalizeWorkdir, repoPath } from '$lib/domain/compose-detect';
import { buildFqdn, isValidSubdomain, isValidZone, normalizeSubdomain, servesDomain } from '$lib/domain/domain-name';
import { errorMessage, RamTightError, SafetyViolation, UserFacingError } from '$lib/domain/errors';
import { hasEnvErrors, maskValue, parseEnv } from '$lib/domain/env-file';
import { isIpv4 } from '$lib/domain/network';
import { assertSafeCommand } from '$lib/domain/safety-policy';
import { assessHostRam, hostMemoryInUse, isSizeKey, SIZES, validateResize, type SizeKey } from '$lib/domain/sizes';
import { isValidSlug, RESERVED_SLUGS, slugify } from '$lib/domain/slug';
import { GENERATED_COMPOSE_FILE } from '$lib/domain/workflow';
import { PROD_BRANCH, validateEnvironment, workflowFileFor, type Environment } from '$lib/domain/environments';
import type { ProjectRow } from '$server/infrastructure/db/schema';
import { ReadCommand } from '../gateways';
import type { JobEngine } from '../jobs/engine';
import type { PowerAction } from '../ports';
import { envAad, type ForgeServices } from '../services';
import { runnerRepoDir, sizeOf } from '../jobs/steps/common';
import { analyzeCompose, type DbKind } from '$lib/domain/compose-analysis';
import { checkEnvAgainst, type ComposeEnvRef } from '$lib/domain/env-template';
import { findEnvTemplate } from './wizard';
import { firewallPlan } from '../jobs/steps/firewall';

export interface DomainInput {
	subdomain: string;
	zone: string;
	/** true : zone OVH gérée ; false : domaine hors OVH (A à créer à la main). */
	managed: boolean;
}

export interface CreateProjectInput {
	name: string;
	slug: string;
	repo: string; // owner/name
	workdir: string;
	appPort: number;
	size: string;
	env: string;
	postDeploy: string;
	appService: string;
	/** Service compose de la base (optionnel) : sauvegardée avant chaque déploiement. */
	dbService?: string;
	domains: DomainInput[];
	acknowledgeRam: boolean;
	/** Production (branche main) par défaut ; développement : branche au choix, jamais main. */
	environment?: Environment;
	branch?: string;
}

export class ProjectService {
	constructor(
		private readonly s: ForgeServices,
		private readonly engine: JobEngine
	) {}

	get(slug: string): ProjectRow {
		const p = this.s.repos.projects.bySlug(slug);
		if (!p || p.status === 'deleted') throw new UserFacingError(`Projet « ${slug} » introuvable.`);
		return p;
	}

	#assertNoActiveJob(p: ProjectRow) {
		const active = this.s.repos.jobs.activeForProject(p.id);
		if (active) throw new UserFacingError(`Un job est déjà en cours pour ce projet (#${active.id}). Attendez sa fin.`);
	}

	async create(input: CreateProjectInput): Promise<{ project: ProjectRow; jobId: number }> {
		const { repos, github, settings, proxmox } = this.s;
		const errors: string[] = [];

		const name = input.name.trim() || input.repo.split('/')[1] || '';
		const environment: Environment = input.environment ?? 'production';
		const slug = slugify(input.slug || name);
		if (!isValidSlug(slug)) errors.push(`Identifiant « ${slug} » invalide (lettres minuscules, chiffres, tirets).`);
		if (RESERVED_SLUGS.has(slug)) errors.push(`« ${slug} » est réservé (nom d'un CT existant).`);
		if (repos.projects.bySlug(slug)) errors.push(`Un projet « ${slug} » existe déjà.`);

		const [owner, repoName] = input.repo.split('/');
		if (!owner || !repoName) errors.push('Dépôt invalide.');
		else if (!this.s.githubOwners().some(Boolean)) errors.push('Propriétaire des dépôts non défini (Réglages → GitHub).');
		else if (!this.s.githubOwners().some((o) => o.toLowerCase() === owner.toLowerCase())) errors.push(`Le dépôt doit appartenir à un compte connecté : ${this.s.githubOwners().filter(Boolean).join(', ')}.`);
		else {
			// Un dépôt a au plus un serveur par environnement (production sur main, développement sur une autre branche).
			errors.push(
				...validateEnvironment(
					{ slug, repo: input.repo, branch: environment === 'production' ? PROD_BRANCH : (input.branch ?? ''), environment },
					repos.projects.list().map((p) => ({ slug: p.slug, repo: `${p.repoOwner}/${p.repoName}`, branch: p.branch, environment: p.environment }))
				)
			);
		}
		if (!isIpv4(settings.get('network.publicIp'))) errors.push('IP publique non définie (Réglages → Réseau).');

		let workdir = '.';
		try {
			workdir = normalizeWorkdir(input.workdir);
		} catch (err) {
			errors.push(errorMessage(err));
		}

		if (!Number.isInteger(input.appPort) || input.appPort < 1 || input.appPort > 65535) errors.push('Port invalide.');
		if (!isSizeKey(input.size)) errors.push('Taille de CT invalide.');
		const size = (isSizeKey(input.size) ? input.size : 'M') as SizeKey;
		const branch = environment === 'production' ? PROD_BRANCH : (input.branch ?? '').trim();

		const env = parseEnv(input.env);
		if (hasEnvErrors(env)) errors.push(...env.issues.filter((i) => i.level === 'error').map((i) => i.message));

		const postDeploy = input.postDeploy.trim();
		if (postDeploy) {
			try {
				assertSafeCommand(postDeploy);
			} catch (err) {
				errors.push(errorMessage(err));
			}
		}
		const appService = input.appService.trim() || 'app';
		if (!isValidServiceName(appService)) errors.push(`Nom de service invalide : ${appService}`);

		const domains: { fqdn: string; zone: string; subdomain: string; mode: 'ovh' | 'manual' }[] = [];
		for (const d of input.domains) {
			const sub = normalizeSubdomain(d.subdomain);
			const zone = d.zone.trim().toLowerCase();
			if (!isValidZone(zone)) {
				errors.push(`Zone invalide : ${d.zone}`);
				continue;
			}
			if (!isValidSubdomain(sub)) {
				errors.push(`Sous-domaine invalide : ${d.subdomain}`);
				continue;
			}
			const fqdn = buildFqdn(sub, zone);
			if (domains.some((x) => x.fqdn === fqdn)) continue;
			if (repos.domains.byFqdn(fqdn)) errors.push(`${fqdn} est déjà utilisé par un projet Forge.`);
			domains.push({ fqdn, zone, subdomain: sub, mode: d.managed ? 'ovh' : 'manual' });
		}
		if (domains.length === 0) errors.push('Ajoutez au moins un domaine.');
		if (!settings.has('ssh.privateKey')) errors.push('Aucune clé SSH : générez-la dans Réglages → Clé SSH (et installez-la dans le template 900).');
		if (errors.length) throw new UserFacingError(errors.join('\n'));

		// Vérifications distantes (lectures).
		const repo = await github.api.getRepo(owner as string, repoName as string);
		const entries = await github.api.listDir(repo.owner, repo.name, workdir === '.' ? '' : workdir, branch);
		const detection = detectDeployMode(entries.filter((e) => e.type === 'file').map((e) => e.name));
		if (!detection.supported || !detection.mode) throw new UserFacingError(detection.reason);

		const hosts = await this.s.proxy.listHosts();
		for (const d of domains) {
			const h = hosts.find((x) => servesDomain(x.domainNames, d.fqdn));
			if (h) throw new UserFacingError(`Un proxy host NPM existe déjà pour ${d.fqdn} (→ ${h.forwardHost}:${h.forwardPort}). Rien n'est écrasé.`);
		}

		const node = await proxmox.nodeStatus();
		const ram = assessHostRam(node.memory.total / 1024 ** 2, hostMemoryInUse(node.memory) / 1024 ** 2, SIZES[size]);
		if (ram.level === 'insufficient') {
			throw new UserFacingError(`RAM insuffisante sur l'hôte : ${Math.round(ram.freeMb)} Mo libres pour un CT de ${SIZES[size].memoryMb} Mo.`);
		}
		if (ram.level === 'tight' && !input.acknowledgeRam) {
			throw new RamTightError(`Il ne resterait que ${Math.round(ram.afterMb)} Mo de RAM libre sur l'hôte : cochez la confirmation pour continuer.`, ram.afterMb);
		}

		// Base de données : seulement un service réel du compose, d'un type pris en charge.
		let db: { dbService: string; dbKind: DbKind } | null = null;
		if (detection.mode === 'compose' && detection.file && input.dbService?.trim()) {
			const content = (await github.api.getFile(repo.owner, repo.name, repoPath(workdir, detection.file), branch))?.content ?? '';
			const found = analyzeCompose(content).databases.find((x) => x.service === input.dbService?.trim());
			if (!found) throw new UserFacingError(`Le service « ${input.dbService} » n'est pas une base reconnue du compose.`);
			db = { dbService: found.service, dbKind: found.kind };
		}

		const project = repos.projects.create({
			slug,
			name,
			repoOwner: repo.owner,
			repoName: repo.name,
			branch,
			environment,
			workdir,
			deployMode: detection.mode,
			composeFile: detection.mode === 'compose' ? detection.file : null,
			appService: detection.mode === 'dockerfile' ? 'app' : appService,
			appPort: input.appPort,
			postDeploy: postDeploy || null,
			...(db ?? {}),
			size,
			status: 'draft'
		});
		repos.projects.update(project.id, {
			envEncrypted: env.normalized.trim() ? this.s.cipher.encrypt(env.normalized, envAad(project.id)) : null,
			envUpdatedAt: Date.now()
		});
		for (const d of domains) repos.domains.create({ projectId: project.id, ...d, status: 'pending' });

		const job = this.engine.enqueue({ type: 'deploy', projectId: project.id });
		return { project: repos.projects.get(project.id) as ProjectRow, jobId: job.id };
	}

	// --- .env --------------------------------------------------------------------------

	envPreview(p: ProjectRow): { entries: { key: string; masked: string; length: number }[]; updatedAt: number | null } {
		const text = this.#envText(p);
		return {
			entries: parseEnv(text).entries.map((e) => ({ key: e.key, masked: maskValue(e.value), length: e.value.length })),
			updatedAt: p.envUpdatedAt
		};
	}

	/** Écart entre le .env du projet et le modèle du dépôt (.env.example + compose). Clés seulement. */
	async envTemplateCheck(p: ProjectRow) {
		try {
			const api = this.s.github.api;
			const template = await findEnvTemplate(api, p.repoOwner, p.repoName, p.workdir, p.branch);
			let refs: ComposeEnvRef[] = [];
			if (p.deployMode === 'compose' && p.composeFile) {
				const file = await api.getFile(p.repoOwner, p.repoName, repoPath(p.workdir, p.composeFile), p.branch);
				refs = file ? analyzeCompose(file.content).envRefs : [];
			}
			const firstDomain = this.s.repos.domains.byProject(p.id)[0]?.fqdn ?? null;
			return { template, check: checkEnvAgainst(this.#envText(p), template, refs), fqdn: firstDomain, error: null };
		} catch (err) {
			return { template: null, check: { missing: [], unfilled: [] }, fqdn: null, error: errorMessage(err) };
		}
	}

	#envText(p: ProjectRow): string {
		return p.envEncrypted ? this.s.cipher.decrypt(p.envEncrypted, envAad(p.id)) : '';
	}

	/** Lecture du .env en clair : uniquement après revérification du mot de passe (côté route). */
	revealEnv(p: ProjectRow): string {
		return this.#envText(p);
	}

	/** Applique des modifications clé par clé (valeur vide = inchangée) ou un remplacement complet. */
	updateEnv(p: ProjectRow, change: { replace?: string; set?: Record<string, string>; remove?: string[] }, redeploy: boolean): number {
		this.#assertNoActiveJob(p);
		let text: string;
		if (change.replace !== undefined) {
			text = change.replace;
		} else {
			const current = parseEnv(this.#envText(p)).entries;
			const map = new Map(current.map((e) => [e.key, e.value]));
			for (const k of change.remove ?? []) map.delete(k);
			for (const [k, v] of Object.entries(change.set ?? {})) {
				if (v !== '' || !map.has(k)) map.set(k, v);
			}
			text = [...map.entries()].map(([k, v]) => `${k}=${quoteEnv(v)}`).join('\n');
		}
		const parsed = parseEnv(text);
		if (hasEnvErrors(parsed)) throw new UserFacingError(parsed.issues.filter((i) => i.level === 'error').map((i) => i.message).join('\n'));
		this.s.repos.projects.update(p.id, {
			envEncrypted: parsed.normalized.trim() ? this.s.cipher.encrypt(parsed.normalized, envAad(p.id)) : null,
			envUpdatedAt: Date.now()
		});
		return this.engine.enqueue({ type: 'update_env', projectId: p.id, params: { onlyEnv: true, redeploy, forceDispatch: true, skipHttpCheck: true } }).id;
	}

	updateSettings(p: ProjectRow, input: { appPort: number; postDeploy: string; appService: string }, redeploy: boolean): number {
		this.#assertNoActiveJob(p);
		if (!Number.isInteger(input.appPort) || input.appPort < 1 || input.appPort > 65535) throw new UserFacingError('Port invalide.');
		const postDeploy = input.postDeploy.trim();
		if (postDeploy) assertSafeCommand(postDeploy);
		if (!isValidServiceName(input.appService)) throw new UserFacingError('Nom de service invalide.');
		const portChanged = input.appPort !== p.appPort;
		this.s.repos.projects.update(p.id, { appPort: input.appPort, postDeploy: postDeploy || null, appService: input.appService });
		// Nouveau port : pare-feu et proxy hosts suivent, puis le contrôle HTTPS le vérifie.
		if (portChanged) return this.engine.enqueue({ type: 'change_port', projectId: p.id, params: { redeploy, forceDispatch: true } }).id;
		return this.engine.enqueue({ type: 'sync_config', projectId: p.id, params: { redeploy, forceDispatch: true, skipHttpCheck: true } }).id;
	}

	// --- Déploiements ------------------------------------------------------------------

	redeploy(p: ProjectRow): number {
		this.#assertNoActiveJob(p);
		return this.engine.enqueue({ type: 'redeploy', projectId: p.id, params: { forceDispatch: true } }).id;
	}

	async runs(p: ProjectRow) {
		return this.s.github.api.listWorkflowRuns(p.repoOwner, p.repoName, workflowFileFor(p.environment), 25);
	}

	async runDetail(p: ProjectRow, runId: number) {
		const api = this.s.github.api;
		const [run, jobs] = await Promise.all([api.getRun(p.repoOwner, p.repoName, runId), api.getRunJobs(p.repoOwner, p.repoName, runId)]);
		const logs = await Promise.all(
			jobs.map(async (j) => ({ jobId: j.id, text: j.status === 'completed' ? this.s.redactor.redact(await api.getJobLogs(p.repoOwner, p.repoName, j.id).catch((e) => errorMessage(e))) : '' }))
		);
		return { run, jobs, logs };
	}

	// --- Domaines -----------------------------------------------------------------------

	async addDomain(p: ProjectRow, d: DomainInput): Promise<number> {
		this.#assertNoActiveJob(p);
		const sub = normalizeSubdomain(d.subdomain);
		const zone = d.zone.trim().toLowerCase();
		if (!isValidZone(zone) || !isValidSubdomain(sub)) throw new UserFacingError('Domaine invalide.');
		const fqdn = buildFqdn(sub, zone);
		if (this.s.repos.domains.byFqdn(fqdn)) throw new UserFacingError(`${fqdn} est déjà utilisé par un projet Forge.`);
		const hosts = await this.s.proxy.listHosts();
		if (hosts.some((h) => servesDomain(h.domainNames, fqdn))) throw new UserFacingError(`Un proxy host NPM existe déjà pour ${fqdn}.`);
		const row = this.s.repos.domains.create({ projectId: p.id, fqdn, zone, subdomain: sub, mode: d.managed ? 'ovh' : 'manual', status: 'pending' });
		return this.engine.enqueue({ type: 'add_domain', projectId: p.id, params: { domainIds: [row.id] } }).id;
	}

	/** Recrée le proxy host d'un domaine actif supprimé à la main dans NPM (certificat réutilisé s'il existe). */
	repairDomain(p: ProjectRow, domainId: number): number {
		this.#assertNoActiveJob(p);
		const d = this.s.repos.domains.get(domainId);
		if (!d || d.projectId !== p.id) throw new UserFacingError('Domaine introuvable.');
		return this.engine.enqueue({ type: 'repair_domain', projectId: p.id, params: { domainIds: [d.id] } }).id;
	}

	removeDomain(p: ProjectRow, domainId: number): number {
		this.#assertNoActiveJob(p);
		const d = this.s.repos.domains.get(domainId);
		if (!d || d.projectId !== p.id) throw new UserFacingError('Domaine introuvable.');
		this.s.repos.domains.update(d.id, { status: 'removing' });
		return this.engine.enqueue({ type: 'remove_domain', projectId: p.id, params: { domainId } }).id;
	}

	async domainsView(p: ProjectRow) {
		const domains = this.s.repos.domains.byProject(p.id);
		let hosts: Awaited<ReturnType<typeof this.s.proxy.listHosts>> = [];
		let error: string | null = null;
		try {
			hosts = await this.s.proxy.listHosts();
		} catch (err) {
			error = errorMessage(err);
		}
		return {
			error,
			domains: domains.map((d) => {
				const h = hosts.find((x) => servesDomain(x.domainNames, d.fqdn));
				return {
					...d,
					proxyHostId: h?.id ?? null,
					certExpiresOn: h?.certificate?.expiresOn ?? null,
					nginxOnline: h?.nginxOnline ?? null,
					forward: h ? `${h.forwardHost}:${h.forwardPort}` : null
				};
			})
		};
	}

	// --- Conteneur ----------------------------------------------------------------------

	power(p: ProjectRow, action: PowerAction): number {
		this.#assertNoActiveJob(p);
		if (!['start', 'stop', 'shutdown', 'reboot'].includes(action)) throw new UserFacingError('Action inconnue.');
		return this.engine.enqueue({ type: 'power', projectId: p.id, params: { action } }).id;
	}

	/** Pare-feu Proxmox du CT : règles Forge attendues vs en place. */
	async firewallView(p: ProjectRow) {
		const plan = firewallPlan(this.s, p);
		if (!p.ctid) return { plan, status: null, clusterEnabled: null, enabledSetting: this.s.settings.bool('firewall.enabled'), error: null };
		try {
			const [status, cluster] = await Promise.all([
				this.s.proxmox.firewallStatus(p.ctid, plan),
				this.s.proxmox.api.clusterFirewallOptions().catch(() => null)
			]);
			return {
				plan,
				status: { enabled: status.enabled, upToDate: status.upToDate, rules: status.rules },
				clusterEnabled: cluster ? Number(cluster.enable ?? 0) === 1 : null,
				enabledSetting: this.s.settings.bool('firewall.enabled'),
				error: null
			};
		} catch (err) {
			return { plan, status: null, clusterEnabled: null, enabledSetting: this.s.settings.bool('firewall.enabled'), error: errorMessage(err) };
		}
	}

	/** Changement de taille : préréglage S/M/L ou valeurs libres. Disque : agrandissement seulement. */
	async resize(p: ProjectRow, target: { preset: string; cores: number; memoryMb: number; diskGb: number }, acknowledgeRam: boolean): Promise<number> {
		this.#assertNoActiveJob(p);
		if (!p.ctid) throw new UserFacingError('Le projet n’a pas encore de CT.');
		if (!isSizeKey(target.preset)) throw new UserFacingError('Taille invalide.');
		const cfg = await this.s.proxmox.guestConfig(p.ctid);
		const currentDiskGb = Number(/size=(\d+)G/.exec(String(cfg.rootfs ?? ''))?.[1] ?? 0);
		const check = validateResize(sizeOf(p), target, currentDiskGb);
		if (check.errors.length) throw new UserFacingError(check.errors.join('\n'));
		if (check.extraMemoryMb > 0) {
			const node = await this.s.proxmox.nodeStatus();
			const ram = assessHostRam(node.memory.total / 1024 ** 2, hostMemoryInUse(node.memory) / 1024 ** 2, { ...SIZES.S, memoryMb: check.extraMemoryMb });
			if (ram.level === 'insufficient') throw new UserFacingError(`RAM insuffisante sur l'hôte : ${Math.round(ram.freeMb)} Mo libres pour ${check.extraMemoryMb} Mo de plus.`);
			if (ram.level === 'tight' && !acknowledgeRam) {
				throw new RamTightError(`Il ne resterait que ${Math.round(ram.afterMb)} Mo de RAM libre sur l'hôte : cochez la confirmation pour continuer.`, ram.afterMb);
			}
		}
		const preset = SIZES[target.preset];
		this.s.repos.projects.update(p.id, {
			size: target.preset,
			cores: target.cores === preset.cores ? null : target.cores,
			memoryMb: target.memoryMb === preset.memoryMb ? null : target.memoryMb,
			diskGb: target.diskGb === preset.diskGb ? null : target.diskGb
		});
		return this.engine.enqueue({ type: 'resize', projectId: p.id }).id;
	}

	applyFirewall(p: ProjectRow): number {
		this.#assertNoActiveJob(p);
		if (!p.ctid) throw new UserFacingError('Le projet n’a pas encore de CT.');
		return this.engine.enqueue({ type: 'firewall', projectId: p.id, params: { forceFirewall: true } }).id;
	}

	/** Partie Proxmox de l'onglet Conteneur (lectures en cache, en parallèle). */
	async containerView(p: ProjectRow) {
		const { proxmox } = this.s;
		if (!p.ctid) return { guest: null, config: null, backups: [] };
		const ctid = p.ctid;
		const [guests, config, backups] = await Promise.all([
			proxmox.guests(),
			proxmox.guestConfig(ctid).catch(() => null),
			proxmox.listBackups(ctid).catch(() => [])
		]);
		const guest = guests.find((g) => g.vmid === ctid) ?? null;
		return { guest, config: guest ? config : null, backups };
	}

	/** Services Docker du CT (docker compose ps par SSH) : plus lent, chargé en différé. */
	async containerServices(p: ProjectRow, running: boolean) {
		let services: { name: string; service: string; state: string; status: string; image: string; ports: string }[] = [];
		let servicesError: string | null = null;
		if (running && p.ip) {
			try {
				const res = await this.s.shell.read({ ip: p.ip, sshHostKey: p.sshHostKey }, ReadCommand.composePs(runnerRepoDir(p), p.workdir, this.#composeFile(p)));
				services = res.stdout
					.split('\n')
					.filter((l) => l.trim().startsWith('{'))
					.map((l) => JSON.parse(l) as Record<string, unknown>)
					.map((r) => ({
						name: String(r.Name ?? ''),
						service: String(r.Service ?? ''),
						state: String(r.State ?? ''),
						status: String(r.Status ?? ''),
						image: String(r.Image ?? ''),
						ports: Array.isArray(r.Publishers)
							? (r.Publishers as { PublishedPort?: number; TargetPort?: number }[])
									.filter((x) => x.PublishedPort)
									.map((x) => `${x.PublishedPort}→${x.TargetPort}`)
									.join(', ')
							: ''
					}));
				if (res.code !== 0 && services.length === 0) servicesError = res.stderr.trim() || 'docker compose ps a échoué (le premier déploiement a-t-il eu lieu ?)';
			} catch (err) {
				servicesError = errorMessage(err);
			}
		}
		return { services, error: servicesError };
	}

	async containerLogs(p: ProjectRow, tail: number, service?: string): Promise<string> {
		if (!p.ip) throw new UserFacingError('Le projet n’a pas de CT.');
		const res = await this.s.shell.read({ ip: p.ip, sshHostKey: p.sshHostKey }, ReadCommand.composeLogs(runnerRepoDir(p), p.workdir, this.#composeFile(p), tail, service));
		return this.s.redactor.redact(res.stdout + (res.stderr ? `\n${res.stderr}` : ''));
	}

	#composeFile(p: ProjectRow) {
		return p.deployMode === 'dockerfile' ? GENERATED_COMPOSE_FILE : (p.composeFile ?? 'docker-compose.yml');
	}

	composePath(p: ProjectRow) {
		return repoPath(p.workdir, this.#composeFile(p));
	}

	// --- Suppression --------------------------------------------------------------------

	delete(p: ProjectRow, confirmName: string, mode: 'full' | 'forget'): number {
		this.#assertNoActiveJob(p);
		if (confirmName.trim() !== p.slug) throw new UserFacingError(`Tapez exactement « ${p.slug} » pour confirmer.`);
		if (mode !== 'full' && mode !== 'forget') throw new SafetyViolation('delete.mode', 'Mode de suppression inconnu.');
		this.s.repos.projects.update(p.id, { status: 'deleting' });
		return this.engine.enqueue({ type: 'delete_project', projectId: p.id, params: { mode } }).id;
	}

	/** Protection par mot de passe (liste d'accès NPM) des proxy hosts d'un projet de dev ; null si le projet n'en a pas. */
	async devProtection(p: ProjectRow): Promise<{ enabled: boolean; hosts: number } | null> {
		const owned = this.s.repos.resources.active({ projectId: p.id });
		if (!owned.some((r) => r.type === 'npm_access_list')) return null;
		const ids = new Set(owned.filter((r) => r.type === 'npm_proxy_host').map((r) => Number(r.externalId)));
		const hosts = (await this.s.proxy.api.listProxyHosts()).filter((h) => ids.has(h.id));
		if (hosts.length === 0) return null;
		return { enabled: hosts.some((h) => h.accessListId > 0), hosts: hosts.length };
	}

	/** Retire (site ouvert à tous) ou remet la liste d'accès sur les proxy hosts du projet, sans toucher aux identifiants. */
	async setDevProtection(p: ProjectRow, enabled: boolean): Promise<void> {
		this.#assertNoActiveJob(p);
		const owned = this.s.repos.resources.active({ projectId: p.id });
		const list = owned.find((r) => r.type === 'npm_access_list');
		if (!list) throw new UserFacingError("Ce projet n'a pas de liste d'accès Forge.");
		const ids = new Set(owned.filter((r) => r.type === 'npm_proxy_host').map((r) => Number(r.externalId)));
		const hosts = (await this.s.proxy.api.listProxyHosts()).filter((h) => ids.has(h.id));
		if (hosts.length === 0) throw new UserFacingError('Aucun proxy host de ce projet dans NPM.');
		for (const h of hosts) await this.s.proxy.setAccessList(h.id, enabled ? Number(list.externalId) : 0);
	}

	/** Identifiants de la liste d'accès du projet (jamais les mots de passe) ; null s'il n'y en a pas. */
	async devAccessUsers(p: ProjectRow): Promise<string[] | null> {
		const list = this.s.repos.resources.active({ projectId: p.id }).find((r) => r.type === 'npm_access_list');
		return list ? this.s.proxy.listAccessListUsers(Number(list.externalId)) : null;
	}

	/** `users` : liste complète voulue ; mot de passe vide = inchangé (obligatoire pour un nouvel identifiant). */
	async saveDevAccessUsers(p: ProjectRow, users: { username: string; password: string }[]): Promise<void> {
		this.#assertNoActiveJob(p);
		const list = this.s.repos.resources.active({ projectId: p.id }).find((r) => r.type === 'npm_access_list');
		if (!list) throw new UserFacingError("Ce projet n'a pas de liste d'accès Forge.");
		if (users.length === 0) throw new UserFacingError('Gardez au moins un identifiant (ou désactivez la protection).');
		const existing = new Set(await this.s.proxy.listAccessListUsers(Number(list.externalId)));
		const seen = new Set<string>();
		for (const u of users) {
			if (!/^[A-Za-z0-9._-]{1,32}$/.test(u.username)) throw new UserFacingError(`Identifiant « ${u.username} » invalide (lettres, chiffres, . _ -, 32 max).`);
			if (seen.has(u.username)) throw new UserFacingError(`Identifiant « ${u.username} » en double.`);
			seen.add(u.username);
			if (!existing.has(u.username) && u.password.length < 8) throw new UserFacingError(`Mot de passe de « ${u.username} » : 8 caractères minimum.`);
			if (u.password && u.password.length < 8) throw new UserFacingError(`Mot de passe de « ${u.username} » : 8 caractères minimum.`);
		}
		await this.s.proxy.setAccessListUsers(
			Number(list.externalId),
			`Forge — ${p.slug}`,
			users.map((u) => ({ username: u.username, password: u.password || undefined }))
		);
	}

	ownedResources(p: ProjectRow) {
		return this.s.repos.resources.active({ projectId: p.id });
	}
}

function quoteEnv(v: string): string {
	if (v === '' || /^[A-Za-z0-9_./:@%+,=-]*$/.test(v)) return v;
	return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

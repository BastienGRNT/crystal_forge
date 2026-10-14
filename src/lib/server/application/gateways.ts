/**
 * Passerelles : seule façon pour les cas d'usage de parler aux systèmes externes.
 * Lectures : déléguées telles quelles. Écritures : TOUJOURS via WriteGuard.run(),
 * avec la règle de sécurité correspondante en `check`.
 */
import { SafetyViolation } from '$lib/domain/errors';
import { ipsFromGuestConfig } from '$lib/domain/network';
import type { SqlDbKind } from '$lib/domain/compose-analysis';
import { BACKUP_ROOT, dumpScript, isValidBackupName, MAX_RESULT_BYTES, queryScript, restoreScript } from '$lib/domain/database';
import { FORGE_RULE_PREFIX, firewallUpToDate, INTERNET_PROBE_URL, isForgeRule, type FirewallOptions, type FirewallRule } from '$lib/domain/firewall';
import {
	assertCanCloneCt,
	assertCanCreateDnsRecord,
	assertCanCreateProxyHost,
	assertCanRepointProxyHost,
	assertCanModifyCt,
	assertForgeSecretName,
	assertForgeVariableName,
	assertGithubRepoAllowed,
	assertOwned,
	assertSafeCommand,
	assertSafeCtConfig,
	assertSshTarget,
	FORGE_SECRET_NAME,
	type GuestFacts,
	type OwnedResource,
	type ResourceType
} from '$lib/domain/safety-policy';
import { TtlCache } from './cache';
import { DRY_PREFIX, isSimulated, type WriteGuard, type WriteOp } from './guard';
import type {
	ExternalApis,
	NpmCreateProxyHost,
	NpmProxyHost,
	OvhRecord,
	PowerAction,
	PveFirewallRule,
	PveGuest,
	SshResult
} from './ports';
import type { SettingsService } from './settings';
import { sealForGithub } from '$server/infrastructure/crypto/sealed-box';

export interface OwnershipStore {
	owned(type?: ResourceType): OwnedResource[];
}

export interface ForgeProjectsLookup {
	/** IP des projets Forge non supprimés. */
	forgeIps(): string[];
	/** « owner/repo » des projets Forge non supprimés. */
	forgeRepos(): string[];
}

interface Deps {
	apis: () => ExternalApis;
	guard: WriteGuard;
	settings: SettingsService;
	ownership: OwnershipStore;
	projects: ForgeProjectsLookup;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Applique fn à chaque élément, au plus `limit` à la fois. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let i = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (i < items.length) {
			const idx = i++;
			out[idx] = await fn(items[idx] as T);
		}
	});
	await Promise.all(workers);
	return out;
}

// =================================================================================
// Proxmox
// =================================================================================

export class ProxmoxGateway {
	/** CT « clonés » pendant un DRY_RUN : considérés comme existants pour la suite du job. */
	readonly #simulatedCts = new Set<number>();
	/** Lectures affichées (pages, tableau de bord). Vidé après chaque écriture et chaque tâche terminée. */
	readonly #cache = new TtlCache();

	constructor(private readonly d: Deps) {}

	get api() {
		return this.d.apis().proxmox;
	}

	version() {
		return this.api.version();
	}
	nodeStatus() {
		return this.#cache.get('node', 5_000, () => this.api.nodeStatus());
	}
	storageStatus(storage = this.d.settings.get('proxmox.storage')) {
		return this.#cache.get(`storage:${storage}`, 10_000, () => this.api.storageStatus(storage));
	}
	/** Liste des CT et VM (cache de 2 s : regroupe les lectures d'une même page). */
	guests() {
		return this.#cache.get('guests', 2_000, () => this.api.guests());
	}
	guestConfig(vmid: number, type: 'lxc' | 'qemu' = 'lxc') {
		if (this.#simulatedCts.has(vmid)) return Promise.resolve({ hostname: 'simulé', rootfs: 'local:simulated,size=6G' } as Record<string, unknown>);
		return this.api.guestConfig(vmid, type);
	}
	permissions(path?: string) {
		return this.api.permissions(path);
	}
	listBackups(vmid: number, opts: { fresh?: boolean } = {}) {
		const read = () => this.api.listBackups(this.d.settings.get('proxmox.backupStorage'), vmid);
		return opts.fresh ? read() : this.#cache.get(`backups:${vmid}`, 30_000, read);
	}

	/**
	 * IP déclarées par chaque CT et VM, pour l'AFFICHAGE (tableau de bord, aperçu de l'assistant) :
	 * une lecture de config par invité, gardée 60 s. Les allocations et le garde utilisent usedIps().
	 */
	guestIps(): Promise<Map<number, string[]>> {
		return this.#cache.get('ips', 60_000, async () => {
			const list = await this.guests();
			const configs = await mapLimit(list, 6, async (g) => {
				try {
					return { vmid: g.vmid, ips: ipsFromGuestConfig(await this.api.guestConfig(g.vmid, g.type)) };
				} catch {
					return { vmid: g.vmid, ips: [] };
				}
			});
			return new Map(configs.map((c) => [c.vmid, c.ips]));
		});
	}

	/** IP déclarées par TOUS les CT et VM (pas seulement ceux du pool), lues en direct. */
	async usedIps(guests?: PveGuest[]): Promise<{ ip: string; vmid: number }[]> {
		const list = guests ?? (await this.api.guests());
		const configs = await mapLimit(list, 4, async (g) => {
			try {
				return { vmid: g.vmid, config: await this.api.guestConfig(g.vmid, g.type) };
			} catch {
				return { vmid: g.vmid, config: {} };
			}
		});
		return configs.flatMap((c) => ipsFromGuestConfig(c.config).map((ip) => ({ ip, vmid: c.vmid })));
	}

	async isIdFree(vmid: number): Promise<boolean> {
		if (this.#simulatedCts.has(vmid)) return false;
		return this.api.isIdFree(vmid);
	}

	async waitTask(upid: string, opts: { timeoutMs?: number; onLine?: (line: string) => void } = {}): Promise<void> {
		if (isSimulated(upid)) return;
		const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
		let logPos = 0;
		while (Date.now() < deadline) {
			const status = await this.api.taskStatus(upid);
			if (opts.onLine) {
				const lines = await this.api.taskLog(upid, logPos).catch(() => []);
				for (const l of lines) {
					logPos = Math.max(logPos, l.n);
					if (l.t && l.t !== 'no content') opts.onLine(l.t);
				}
			}
			if (status.status === 'stopped') {
				// Clone, démarrage, sauvegarde… terminés : l'état affiché a changé.
				this.#cache.clear();
				if (status.exitstatus && status.exitstatus !== 'OK' && !status.exitstatus.startsWith('WARNINGS')) {
					throw new Error(`Tâche Proxmox en échec : ${status.exitstatus}`);
				}
				return;
			}
			await sleep(1500);
		}
		throw new Error(`Tâche Proxmox toujours en cours après ${Math.round((opts.timeoutMs ?? 600_000) / 1000)} s`);
	}

	async #facts(vmid: number): Promise<GuestFacts> {
		if (this.#simulatedCts.has(vmid)) return { vmid, pool: this.d.settings.get('proxmox.pool'), template: false, exists: true };
		// Contrôle de sécurité : état réel, jamais le cache.
		const g = (await this.api.guests()).find((x) => x.vmid === vmid);
		return { vmid, pool: g?.pool ?? null, template: g?.template ?? false, exists: !!g };
	}

	#owned(): OwnedResource[] {
		const owned = this.d.ownership.owned('pve_ct');
		for (const id of this.#simulatedCts) owned.push({ type: 'pve_ct', externalId: String(id), projectId: null });
		return owned;
	}

	/** Écriture gardée ; le cache est vidé ensuite, qu'elle réussisse ou non. */
	#run<T>(op: WriteOp<T>): Promise<T> {
		return this.d.guard.run(op).finally(() => this.#cache.clear());
	}

	async #assertModifiable(vmid: number) {
		assertCanModifyCt(this.d.settings.safetyContext(), await this.#facts(vmid), this.#owned());
	}

	cloneTemplate(newId: number, hostname: string, description: string): Promise<string> {
		const s = this.d.settings;
		const templateId = s.int('proxmox.templateId');
		const pool = s.get('proxmox.pool');
		return this.#run({
			system: 'proxmox',
			action: 'lxc.clone',
			summary: `Cloner le template ${templateId} → CT ${newId} « ${hostname} » (pool ${pool}, clone complet sur ${s.get('proxmox.storage')})`,
			check: async () => {
				const existingIds = (await this.api.guests()).map((g) => g.vmid);
				assertCanCloneCt(s.safetyContext(), { sourceId: templateId, newId, pool, existingIds });
				if (!(await this.api.isIdFree(newId))) throw new SafetyViolation('clone.exists', `Le CTID ${newId} est déjà pris.`);
			},
			execute: () =>
				this.api.clone(templateId, { newid: newId, hostname, pool, storage: s.get('proxmox.storage'), full: true, description }),
			simulate: () => {
				this.#simulatedCts.add(newId);
				return `${DRY_PREFIX}:clone:${newId}`;
			}
		});
	}

	configure(vmid: number, config: Record<string, string | number>): Promise<void> {
		return this.#run({
			system: 'proxmox',
			action: 'lxc.config',
			summary: `Configurer le CT ${vmid} : ${Object.entries(config)
				.map(([k, v]) => `${k}=${k === 'description' ? '…' : v}`)
				.join(', ')}`,
			check: async () => {
				await this.#assertModifiable(vmid);
				const used = (await this.usedIps()).filter((u) => u.vmid !== vmid).map((u) => u.ip);
				assertSafeCtConfig(this.d.settings.safetyContext(), config, used);
			},
			execute: () => this.api.updateConfig(vmid, config),
			simulate: () => undefined
		});
	}

	resize(vmid: number, sizeGb: number): Promise<string | null> {
		return this.#run({
			system: 'proxmox',
			action: 'lxc.resize',
			summary: `Agrandir le disque du CT ${vmid} à ${sizeGb} Go`,
			check: () => this.#assertModifiable(vmid),
			execute: () => this.api.resize(vmid, 'rootfs', `${sizeGb}G`),
			simulate: () => `${DRY_PREFIX}:resize:${vmid}`
		});
	}

	power(vmid: number, action: PowerAction): Promise<string> {
		const labels: Record<PowerAction, string> = { start: 'Démarrer', stop: 'Arrêter (forcé)', shutdown: 'Éteindre', reboot: 'Redémarrer' };
		return this.#run({
			system: 'proxmox',
			action: `lxc.${action}`,
			summary: `${labels[action]} le CT ${vmid}`,
			check: () => this.#assertModifiable(vmid),
			execute: () => this.api.power(vmid, action),
			simulate: () => `${DRY_PREFIX}:${action}:${vmid}`
		});
	}

	backup(vmid: number): Promise<string> {
		const storage = this.d.settings.get('proxmox.backupStorage');
		return this.#run({
			system: 'proxmox',
			action: 'vzdump',
			summary: `Sauvegarder le CT ${vmid} (vzdump snapshot, zstd) sur ${storage}`,
			check: () => this.#assertModifiable(vmid),
			execute: () => this.api.vzdump(vmid, storage),
			simulate: () => `${DRY_PREFIX}:vzdump:${vmid}`
		});
	}

	/** État du pare-feu d'un CT (lecture). */
	async firewallStatus(vmid: number, plan: FirewallRule[]) {
		if (this.#simulatedCts.has(vmid)) return { enabled: false, upToDate: false, rules: [] as PveFirewallRule[], options: {} as Record<string, unknown> };
		const [options, rules] = await Promise.all([this.api.ctFirewallOptions(vmid), this.api.ctFirewallRules(vmid)]);
		return { enabled: Number(options.enable ?? 0) === 1, upToDate: Number(options.enable ?? 0) === 1 && firewallUpToDate(rules, plan), rules, options };
	}

	/**
	 * Remplace les règles « forge: » du CT par le plan et active le pare-feu.
	 * Les règles ajoutées à la main (sans ce préfixe) ne sont jamais touchées.
	 */
	applyFirewall(vmid: number, plan: FirewallRule[], options: FirewallOptions): Promise<void> {
		return this.#run({
			system: 'proxmox',
			action: 'lxc.firewall',
			summary: `Pare-feu du CT ${vmid} : ${plan.length} règle(s) Forge, entrée DROP par défaut, anti-usurpation IP`,
			check: async () => {
				await this.#assertModifiable(vmid);
				if (plan.some((r) => !r.comment.startsWith(FORGE_RULE_PREFIX))) throw new SafetyViolation('firewall.rule', 'Règle sans préfixe « forge: » refusée.');
			},
			execute: async () => {
				const current = await this.api.ctFirewallRules(vmid);
				for (const r of current.filter(isForgeRule).sort((a, b) => b.pos - a.pos)) await this.api.deleteCtFirewallRule(vmid, r.pos);
				// Chaque ajout se place en tête : on ajoute à l'envers pour garder l'ordre du plan.
				for (const r of [...plan].reverse()) await this.api.addCtFirewallRule(vmid, { ...r });
				await this.api.setCtFirewallOptions(vmid, { ...options });
			},
			simulate: () => undefined
		});
	}

	async destroy(vmid: number): Promise<string> {
		// Un CT protégé (protection=1, héritée du template) ne peut pas être supprimé :
		// on retire d'abord la protection, via le garde (CT du pool, créé par Forge).
		if (!this.#simulatedCts.has(vmid)) {
			const facts = await this.#facts(vmid);
			if (facts.exists && facts.pool === this.d.settings.get('proxmox.pool')) {
				const cfg = await this.api.guestConfig(vmid, 'lxc');
				if (Number(cfg.protection ?? 0) === 1) await this.configure(vmid, { protection: 0 });
			}
		}
		return this.#run({
			system: 'proxmox',
			action: 'lxc.destroy',
			summary: `SUPPRIMER le CT ${vmid} et ses disques`,
			check: () => this.#assertModifiable(vmid),
			execute: () => this.api.destroy(vmid),
			simulate: () => {
				this.#simulatedCts.delete(vmid);
				return `${DRY_PREFIX}:destroy:${vmid}`;
			}
		});
	}
}

// =================================================================================
// GitHub
// =================================================================================

export class GithubGateway {
	constructor(private readonly d: Deps) {}

	get api() {
		return this.d.apis().github;
	}

	#assertRepo(owner: string, repo: string) {
		assertGithubRepoAllowed(owner, repo, this.d.settings.get('github.owner'), this.d.projects.forgeRepos());
	}

	createRegistrationToken(owner: string, repo: string) {
		return this.d.guard.run({
			system: 'github',
			action: 'runner.registration-token',
			summary: `Créer un jeton d'enregistrement de runner pour ${owner}/${repo}`,
			check: () => this.#assertRepo(owner, repo),
			execute: () => this.api.createRegistrationToken(owner, repo),
			simulate: () => ({ token: `${DRY_PREFIX}-registration-token`, expiresAt: new Date(Date.now() + 3600_000).toISOString() })
		});
	}

	deleteRunner(owner: string, repo: string, runnerId: number) {
		return this.d.guard.run({
			system: 'github',
			action: 'runner.delete',
			summary: `Retirer le runner #${runnerId} de ${owner}/${repo}`,
			check: () => {
				this.#assertRepo(owner, repo);
				assertOwned('gh_runner', `${owner}/${repo}:${runnerId}`, this.d.ownership.owned('gh_runner'), 'Le runner');
			},
			execute: () => this.api.deleteRunner(owner, repo, runnerId),
			simulate: () => undefined
		});
	}

	async putEnvSecret(owner: string, repo: string, envText: string): Promise<void> {
		this.#assertRepo(owner, repo);
		const key = await this.api.getPublicKey(owner, repo);
		const sealed = await sealForGithub(key.key, envText);
		await this.d.guard.run({
			system: 'github',
			action: 'secret.put',
			summary: `Écrire le secret ${FORGE_SECRET_NAME} de ${owner}/${repo} (${new TextEncoder().encode(envText).length} octets, chiffré libsodium)`,
			check: () => {
				this.#assertRepo(owner, repo);
				assertForgeSecretName(FORGE_SECRET_NAME);
			},
			execute: () => this.api.putSecret(owner, repo, FORGE_SECRET_NAME, sealed, key.keyId),
			simulate: () => undefined
		});
	}

	deleteEnvSecret(owner: string, repo: string) {
		return this.d.guard.run({
			system: 'github',
			action: 'secret.delete',
			summary: `Supprimer le secret ${FORGE_SECRET_NAME} de ${owner}/${repo}`,
			check: () => {
				this.#assertRepo(owner, repo);
				assertOwned('gh_secret', `${owner}/${repo}:${FORGE_SECRET_NAME}`, this.d.ownership.owned('gh_secret'), 'Le secret');
			},
			execute: () => this.api.deleteSecret(owner, repo, FORGE_SECRET_NAME),
			simulate: () => undefined
		});
	}

	setVariable(owner: string, repo: string, name: string, value: string) {
		return this.d.guard.run({
			system: 'github',
			action: 'variable.set',
			summary: `Variable ${name} = « ${value} » sur ${owner}/${repo}`,
			check: () => {
				this.#assertRepo(owner, repo);
				assertForgeVariableName(name);
			},
			execute: () => this.api.setVariable(owner, repo, name, value),
			simulate: () => 'created' as const
		});
	}

	deleteVariable(owner: string, repo: string, name: string) {
		return this.d.guard.run({
			system: 'github',
			action: 'variable.delete',
			summary: `Supprimer la variable ${name} de ${owner}/${repo}`,
			check: () => {
				this.#assertRepo(owner, repo);
				assertForgeVariableName(name);
			},
			execute: () => this.api.deleteVariable(owner, repo, name),
			simulate: () => undefined
		});
	}

	createWorkflowFile(owner: string, repo: string, path: string, content: string, branch: string) {
		return this.d.guard.run({
			system: 'github',
			action: 'contents.create',
			summary: `Commiter ${path} sur ${owner}/${repo}@${branch}`,
			check: async () => {
				this.#assertRepo(owner, repo);
				if (!path.startsWith('.github/workflows/forge-')) throw new SafetyViolation('github.path', `Chemin interdit : ${path}`);
				const existing = await this.api.getFile(owner, repo, path, branch);
				if (existing) throw new SafetyViolation('github.file-exists', `${path} existe déjà sur ${branch} : Forge ne l'écrase pas.`);
			},
			execute: () => this.api.createFile(owner, repo, path, content, 'chore(forge): ajoute le workflow de déploiement Forge', branch),
			simulate: () => ({ commitSha: `${DRY_PREFIX}-commit`, contentSha: `${DRY_PREFIX}-sha` })
		});
	}

	/**
	 * Met à jour le workflow Forge, seulement s'il n'a pas été modifié depuis le dernier
	 * commit de Forge (sha enregistré). Commit « [skip ci] » : pas de déploiement déclenché.
	 */
	updateWorkflowFile(owner: string, repo: string, path: string, content: string, branch: string, sha: string) {
		const id = `${owner}/${repo}:${path}`;
		return this.d.guard.run({
			system: 'github',
			action: 'contents.update',
			summary: `Mettre à jour ${path} sur ${owner}/${repo}@${branch}`,
			check: async () => {
				this.#assertRepo(owner, repo);
				if (!path.startsWith('.github/workflows/forge-')) throw new SafetyViolation('github.path', `Chemin interdit : ${path}`);
				assertOwned('gh_workflow', id, this.d.ownership.owned('gh_workflow'), 'Le fichier');
				const current = await this.api.getFile(owner, repo, path, branch);
				if (!current || current.sha !== sha) throw new SafetyViolation('github.file-changed', `${path} a changé depuis la lecture : rien n'est écrasé.`);
			},
			execute: () => this.api.updateFile(owner, repo, path, content, 'chore(forge): met à niveau le workflow de déploiement [skip ci]', branch, sha),
			simulate: () => ({ commitSha: `${DRY_PREFIX}-commit`, contentSha: `${DRY_PREFIX}-sha` })
		});
	}

	deleteWorkflowFile(owner: string, repo: string, path: string, sha: string, branch: string) {
		return this.d.guard.run({
			system: 'github',
			action: 'contents.delete',
			summary: `Supprimer ${path} de ${owner}/${repo}@${branch}`,
			check: () => {
				this.#assertRepo(owner, repo);
				assertOwned('gh_workflow', `${owner}/${repo}:${path}`, this.d.ownership.owned('gh_workflow'), 'Le fichier');
			},
			execute: () => this.api.deleteFile(owner, repo, path, sha, 'chore(forge): retire le workflow de déploiement Forge', branch),
			simulate: () => undefined
		});
	}

	dispatch(owner: string, repo: string, workflowFile: string, ref: string) {
		return this.d.guard.run({
			system: 'github',
			action: 'workflow.dispatch',
			summary: `Lancer ${workflowFile} sur ${owner}/${repo}@${ref}`,
			check: () => this.#assertRepo(owner, repo),
			execute: () => this.api.dispatchWorkflow(owner, repo, workflowFile, ref),
			simulate: () => ({ runId: null, htmlUrl: null })
		});
	}
}

// =================================================================================
// DNS OVH
// =================================================================================

export class DnsGateway {
	readonly #cache = new TtlCache();

	constructor(private readonly d: Deps) {}

	get api() {
		return this.d.apis().ovh;
	}

	/** Zones du compte, lues en direct (étape DNS). */
	listZones() {
		return this.api.listZones();
	}

	/** Zones pour l'affichage (formulaires, réglages) : elles changent rarement, gardées 5 min. */
	zones() {
		return this.#cache.get('zones', 5 * 60_000, () => this.api.listZones());
	}

	async recordsFor(zone: string, subDomain: string): Promise<OvhRecord[]> {
		// Pour le domaine racine, le filtre subDomain vide n'est pas fiable : on lit tout et on filtre.
		const ids = await this.api.listRecordIds(zone, subDomain ? { subDomain } : {});
		const records = await mapLimit(ids, 4, (id) => this.api.getRecord(zone, id));
		return records.filter((r) => r.subDomain.toLowerCase() === subDomain.toLowerCase());
	}

	/** Enregistrements wildcard de la zone (pour signaler un wildcard qui couvrirait le nom). */
	async wildcardRecords(zone: string, subDomain: string): Promise<OvhRecord[]> {
		const parent = subDomain.includes('.') ? subDomain.slice(subDomain.indexOf('.') + 1) : '';
		return this.recordsFor(zone, parent ? `*.${parent}` : '*');
	}

	createARecord(zone: string, subDomain: string): Promise<OvhRecord> {
		const target = this.d.settings.get('network.publicIp');
		const name = subDomain ? `${subDomain}.${zone}` : zone;
		return this.d.guard.run({
			system: 'ovh',
			action: 'record.create',
			summary: `Créer l'enregistrement A ${name} → ${target} (TTL 300)`,
			check: async () => {
				const zones = await this.api.listZones();
				if (!zones.includes(zone)) throw new SafetyViolation('dns.zone', `La zone ${zone} n'est pas gérée par ce compte OVH.`);
				const existing = await this.recordsFor(zone, subDomain);
				assertCanCreateDnsRecord(this.d.settings.safetyContext(), { zone, subDomain, fieldType: 'A', target }, existing);
			},
			execute: () => this.api.createRecord(zone, { fieldType: 'A', subDomain, target, ttl: 300 }),
			simulate: () => ({ id: -Date.now(), zone, fieldType: 'A', subDomain, target, ttl: 300 })
		});
	}

	refreshZone(zone: string) {
		return this.d.guard.run({
			system: 'ovh',
			action: 'zone.refresh',
			summary: `Appliquer la zone ${zone} (refresh)`,
			execute: () => this.api.refreshZone(zone),
			simulate: () => undefined
		});
	}

	deleteRecord(zone: string, id: number) {
		return this.d.guard.run({
			system: 'ovh',
			action: 'record.delete',
			summary: `Supprimer l'enregistrement DNS #${id} de ${zone}`,
			check: async () => {
				assertOwned('ovh_record', `${zone}:${id}`, this.d.ownership.owned('ovh_record'), "L'enregistrement DNS");
				const rec = await this.api.getRecord(zone, id);
				if (rec.fieldType !== 'A' || rec.target !== this.d.settings.get('network.publicIp')) {
					throw new SafetyViolation('dns.changed', `L'enregistrement #${id} a été modifié hors de Forge (${rec.fieldType} → ${rec.target}) : non supprimé.`);
				}
			},
			execute: () => this.api.deleteRecord(zone, id),
			simulate: () => undefined
		});
	}
}

// =================================================================================
// Nginx Proxy Manager
// =================================================================================

export class ProxyGateway {
	/** Lectures affichées ; vidé après chaque écriture. Les contrôles du garde lisent en direct. */
	readonly #cache = new TtlCache();

	constructor(private readonly d: Deps) {}

	get api() {
		return this.d.apis().npm;
	}

	/** Proxy hosts pour l'affichage et les vérifications préalables (gardés 10 s). */
	listHosts() {
		return this.#cache.get('hosts', 10_000, () => this.api.listProxyHosts());
	}
	#run<T>(op: WriteOp<T>): Promise<T> {
		return this.d.guard.run(op).finally(() => this.#cache.clear());
	}

	listCertificates() {
		return this.api.listCertificates();
	}

	/** `certificateId` : certificat Let's Encrypt créé par Forge à réutiliser (sinon, nouvelle demande). */
	async createProxyHost(input: { domain: string; forwardHost: string; forwardPort: number; email: string; certificateId?: number }): Promise<NpmProxyHost> {
		const payload: NpmCreateProxyHost = {
			domain_names: [input.domain],
			forward_scheme: 'http',
			forward_host: input.forwardHost,
			forward_port: input.forwardPort,
			certificate_id: input.certificateId ?? 'new',
			ssl_forced: true,
			http2_support: true,
			block_exploits: true,
			allow_websocket_upgrade: true,
			hsts_enabled: false,
			caching_enabled: false,
			access_list_id: 0,
			advanced_config: '',
			enabled: true,
			locations: [],
			meta: { letsencrypt_agree: true, letsencrypt_email: input.email, dns_challenge: false }
		};
		return this.#run({
			system: 'npm',
			action: 'proxy-host.create',
			summary: `Créer le proxy host ${input.domain} → http://${input.forwardHost}:${input.forwardPort} (${input.certificateId ? `certificat #${input.certificateId} réutilisé` : "Let's Encrypt"}, SSL forcé, HTTP/2, websockets)`,
			check: async () => {
				if (input.certificateId) assertOwned('npm_certificate', input.certificateId, this.d.ownership.owned('npm_certificate'), 'Le certificat');
				const hosts = await this.api.listProxyHosts();
				assertCanCreateProxyHost(
					this.d.settings.safetyContext(),
					{ domainNames: payload.domain_names, forwardHost: input.forwardHost, forwardPort: input.forwardPort },
					hosts.flatMap((h) => h.domainNames)
				);
			},
			execute: () => this.api.createProxyHost(payload),
			simulate: () => ({
				id: -Date.now(),
				domainNames: payload.domain_names,
				forwardScheme: 'http',
				forwardHost: input.forwardHost,
				forwardPort: input.forwardPort,
				certificateId: -1,
				sslForced: true,
				enabled: true,
				nginxOnline: null,
				nginxError: null,
				certificate: null
			})
		});
	}

	/** Nouveau port de l'app : le proxy host (créé par Forge) garde son domaine, son certificat et sa cible. */
	repointProxyHost(id: number, forwardHost: string, forwardPort: number): Promise<NpmProxyHost> {
		return this.#run({
			system: 'npm',
			action: 'proxy-host.update',
			summary: `Rediriger le proxy host #${id} vers http://${forwardHost}:${forwardPort}`,
			check: async () => {
				const host = (await this.api.listProxyHosts()).find((h) => h.id === id);
				if (!host) throw new SafetyViolation('npm.missing', `Le proxy host #${id} n'existe plus dans NPM.`);
				assertCanRepointProxyHost(this.d.settings.safetyContext(), host, { forwardHost, forwardPort }, this.d.ownership.owned('npm_proxy_host'));
			},
			execute: () => this.api.updateProxyHost(id, { forward_host: forwardHost, forward_port: forwardPort }),
			simulate: () => ({
				id,
				domainNames: [],
				forwardScheme: 'http',
				forwardHost,
				forwardPort,
				certificateId: -1,
				sslForced: true,
				enabled: true,
				nginxOnline: null,
				nginxError: null,
				certificate: null
			})
		});
	}

	deleteProxyHost(id: number) {
		return this.#run({
			system: 'npm',
			action: 'proxy-host.delete',
			summary: `Supprimer le proxy host #${id}`,
			check: () => assertOwned('npm_proxy_host', id, this.d.ownership.owned('npm_proxy_host'), 'Le proxy host'),
			execute: () => this.api.deleteProxyHost(id),
			simulate: () => undefined
		});
	}

	deleteCertificate(id: number) {
		return this.#run({
			system: 'npm',
			action: 'certificate.delete',
			summary: `Supprimer le certificat #${id}`,
			check: () => assertOwned('npm_certificate', id, this.d.ownership.owned('npm_certificate'), 'Le certificat'),
			execute: () => this.api.deleteCertificate(id),
			simulate: () => undefined
		});
	}
}

// =================================================================================
// SSH
// =================================================================================

export interface ShellTarget {
	ip: string;
	sshHostKey: string | null;
}

export class ShellGateway {
	constructor(
		private readonly d: Deps,
		private readonly onHostKey: (ip: string, fingerprint: string) => void
	) {}

	#target(t: ShellTarget, user: 'root' | 'github') {
		const privateKey = this.d.settings.get('ssh.privateKey');
		if (!privateKey) throw new Error('Aucune clé SSH configurée (Réglages → Clé SSH).');
		return { host: t.ip, user, privateKey, expectedHostKey: t.sshHostKey };
	}

	async #exec(t: ShellTarget, user: 'root' | 'github', command: string, onOutput?: (s: string) => void, timeoutMs?: number, stdin?: Buffer) {
		const res = await this.d.apis().ssh.exec(this.#target(t, user), command, { onOutput, timeoutMs, stdin });
		if (!t.sshHostKey && res.hostKey) this.onHostKey(t.ip, res.hostKey);
		return res;
	}

	#checks(t: ShellTarget, command: string) {
		assertSshTarget(this.d.settings.safetyContext(), t.ip, this.d.projects.forgeIps());
		assertSafeCommand(command);
	}

	/** Commande qui modifie le CT : passe par le garde (DRY_RUN respecté). */
	run(
		t: ShellTarget,
		user: 'root' | 'github',
		command: string,
		opts: { summary?: string; onOutput?: (s: string) => void; timeoutMs?: number } = {}
	): Promise<SshResult> {
		return this.d.guard.run({
			system: 'ssh',
			action: 'exec',
			summary: `${user}@${t.ip} $ ${opts.summary ?? command}`,
			check: () => this.#checks(t, command),
			execute: () => this.#exec(t, user, command, opts.onOutput, opts.timeoutMs),
			simulate: () => ({ code: 0, stdout: '', stderr: '', hostKey: t.sshHostKey ?? '' })
		});
	}

	/** Lecture seule (docker compose ps / logs) : exécutée même en DRY_RUN. */
	async read(t: ShellTarget, command: ReadCommand): Promise<SshResult> {
		const cmd = command.toString();
		this.#checks(t, cmd);
		return this.#exec(t, 'github', cmd, undefined, 30_000);
	}

	/** Commande base de données en lecture (requête lecture seule, liste des sauvegardes…). */
	async dbRead(t: ShellTarget, command: DbCommand, timeoutMs = 45_000): Promise<SshResult> {
		if (!command.readOnly) throw new SafetyViolation('db.write', 'Commande d’écriture refusée hors du garde.');
		const cmd = command.toString();
		this.#checks(t, cmd);
		return this.#exec(t, 'github', cmd, undefined, timeoutMs);
	}

	/** Commande base de données qui écrit (requête, dump, restauration) : passe par le garde. */
	dbWrite(t: ShellTarget, command: DbCommand, summary: string, timeoutMs = 15 * 60_000, stdin?: Buffer): Promise<SshResult> {
		const cmd = command.toString();
		return this.d.guard.run({
			system: 'ssh',
			action: `db.${command.op}`,
			summary: `github@${t.ip} · ${summary}`,
			check: () => this.#checks(t, cmd),
			execute: () => this.#exec(t, 'github', cmd, undefined, timeoutMs, stdin),
			simulate: () => ({ code: 0, stdout: '', stderr: '', hostKey: t.sshHostKey ?? '' })
		});
	}

	/** Test de connexion (commande `true`) : lecture, autorisée en DRY_RUN. */
	async ping(t: ShellTarget): Promise<SshResult> {
		this.#checks(t, 'true');
		return this.#exec(t, 'root', 'true', undefined, 15_000);
	}
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Commandes de lecture autorisées, construites ici (jamais de texte libre). */
export class ReadCommand {
	private constructor(private readonly cmd: string) {}
	toString() {
		return this.cmd;
	}
	static composePs(repoDir: string, workdir: string, composeFile: string) {
		return new ReadCommand(`cd ${shq(`${repoDir}/${workdir}`)} && docker compose -f ${shq(composeFile)} ps --all --format json`);
	}
	static composeLogs(repoDir: string, workdir: string, composeFile: string, tail: number, service?: string) {
		const n = Math.min(Math.max(Math.trunc(tail), 10), 2000);
		const svc = service && /^[a-zA-Z0-9_.-]+$/.test(service) ? ` ${service}` : '';
		return new ReadCommand(`cd ${shq(`${repoDir}/${workdir}`)} && docker compose -f ${shq(composeFile)} logs --no-color --timestamps --tail ${n}${svc}`);
	}
	/** Versions et état des mises à jour automatiques du CT (lecture seule). */
	static versions() {
		return new ReadCommand(
			`: forge-op=versions; echo "docker=$(docker version --format '{{.Server.Version}}' 2>/dev/null)"; echo "unattended=$(systemctl is-enabled unattended-upgrades 2>/dev/null || echo absent)"; . /etc/os-release && echo "os=$PRETTY_NAME"`
		);
	}
	/** Accès Internet du CT (NAT) : code HTTP de l'API GitHub, « 000 » si injoignable. */
	static internet() {
		return new ReadCommand(`: forge-op=internet; curl -sS -o /dev/null -m 8 -w '%{http_code}' ${shq(INTERNET_PROBE_URL)}`);
	}
}

/** Emplacement du service de base dans le compose du projet. */
export interface DbLocation {
	repoDir: string;
	workdir: string;
	composeFile: string;
	service: string;
	kind: SqlDbKind;
	slug: string;
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

function assertSlug(slug: string) {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new SafetyViolation('db.slug', `Projet invalide : ${slug}`);
}

function assertLocation(l: DbLocation) {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(l.service)) throw new SafetyViolation('db.service', `Service invalide : ${l.service}`);
	assertSlug(l.slug);
}

/**
 * Commandes base de données, construites ici uniquement. La requête SQL n'apparaît
 * jamais en clair dans la ligne de commande : elle est passée en base64 sur l'entrée
 * standard du client, lancé DANS le conteneur de la base avec ses propres identifiants.
 */
export class DbCommand {
	private constructor(
		readonly op: 'query' | 'backup' | 'restore' | 'list' | 'download' | 'inspect' | 'import',
		readonly readOnly: boolean,
		private readonly cmd: string
	) {}
	toString() {
		return this.cmd;
	}

	/**
	 * Entre parenthèses : utilisé après un « | », un `cd … && docker compose …` nu se lirait
	 * `(… | cd …) && docker compose …` — le cd tournerait dans le sous-shell du tube et
	 * docker compose partirait du dossier personnel, sans l'entrée standard.
	 */
	static #exec(l: DbLocation, script: string) {
		assertLocation(l);
		return `(cd ${shq(`${l.repoDir}/${l.workdir}`)} && docker compose -f ${shq(l.composeFile)} exec -T ${shq(l.service)} sh -c ${shq(script)})`;
	}

	static #dir(l: Pick<DbLocation, 'slug'>) {
		return `${BACKUP_ROOT}/${l.slug}`;
	}

	static query(l: DbLocation, sql: string, readOnly: boolean) {
		const body = `printf %s ${shq(b64(sql))} | base64 -d | ${DbCommand.#exec(l, queryScript(l.kind, readOnly))}`;
		return new DbCommand('query', readOnly, `: forge-db=query; { ${body}; echo "__FORGE_RC=$?" >&2; } | head -c ${MAX_RESULT_BYTES + 1}`);
	}

	static backup(l: DbLocation, name: string) {
		if (!isValidBackupName(name)) throw new SafetyViolation('db.backup-name', `Nom de sauvegarde invalide : ${name}`);
		const dir = DbCommand.#dir(l);
		const file = `${dir}/${name}`;
		return new DbCommand(
			'backup',
			false,
			`: forge-db=backup; set -o pipefail; mkdir -p ${shq(dir)} && umask 077 && ${DbCommand.#exec(l, dumpScript(l.kind))} | gzip > ${shq(`${file}.part`)} && mv ${shq(`${file}.part`)} ${shq(file)} && stat -c %s ${shq(file)}`
		);
	}

	static restore(l: DbLocation, name: string) {
		if (!isValidBackupName(name)) throw new SafetyViolation('db.backup-name', `Nom de sauvegarde invalide : ${name}`);
		const file = `${DbCommand.#dir(l)}/${name}`;
		return new DbCommand('restore', false, `: forge-db=restore; set -o pipefail; gunzip -c ${shq(file)} | ${DbCommand.#exec(l, restoreScript(l.kind))}`);
	}

	/** Écrit le dump gzip lu sur l'entrée standard dans le dossier des sauvegardes (vérifié avec gzip -t). */
	static importDump(l: Pick<DbLocation, 'slug'>, name: string) {
		assertSlug(l.slug);
		if (!isValidBackupName(name)) throw new SafetyViolation('db.backup-name', `Nom de sauvegarde invalide : ${name}`);
		const dir = DbCommand.#dir(l);
		const part = shq(`${dir}/${name}.part`);
		return new DbCommand(
			'import',
			false,
			`: forge-db=import; mkdir -p ${shq(dir)} && umask 077 && cat > ${part} && gzip -t ${part} && mv ${part} ${shq(`${dir}/${name}`)} && stat -c %s ${shq(`${dir}/${name}`)} || { rm -f ${part}; exit 1; }`
		);
	}

	static listBackups(l: Pick<DbLocation, 'slug'>) {
		assertSlug(l.slug);
		return new DbCommand('list', true, `: forge-db=list; find ${shq(DbCommand.#dir(l))} -maxdepth 1 -name '*.sql.gz' -printf '%f\t%s\t%T@\n' 2>/dev/null || true`);
	}

	static download(l: Pick<DbLocation, 'slug'>, name: string, maxBytes: number) {
		assertSlug(l.slug);
		if (!isValidBackupName(name)) throw new SafetyViolation('db.backup-name', `Nom de sauvegarde invalide : ${name}`);
		const file = shq(`${DbCommand.#dir(l)}/${name}`);
		return new DbCommand('download', true, `: forge-db=download; S=$(stat -c %s ${file}) && echo "$S" && if [ "$S" -le ${maxBytes} ]; then base64 -w0 ${file}; fi`);
	}

	/** Adresse IP du conteneur de la base (pour un tunnel SSH depuis DataGrip). */
	static inspect(l: DbLocation) {
		assertLocation(l);
		return new DbCommand(
			'inspect',
			true,
			`: forge-db=inspect; cd ${shq(`${l.repoDir}/${l.workdir}`)} && docker compose -f ${shq(l.composeFile)} ps -q ${shq(l.service)} | xargs -r docker inspect -f '{{.State.Status}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}'`
		);
	}
}

/**
 * Racine de composition : construit tous les services une seule fois (singleton
 * conservé à travers le rechargement à chaud) selon le mode live ou mock.
 */
import { ConnectionTester } from './application/use-cases/connections';
import { DashboardService } from './application/use-cases/dashboard';
import { WizardService } from './application/use-cases/wizard';
import { ProjectService } from './application/use-cases/projects';
import { AccountService } from './application/accounts';
import { routeGithub, routeOvh } from './infrastructure/account-routing';
import { AuthService } from './application/use-cases/auth';
import { SpaceService } from './application/use-cases/spaces';
import { MonitorService } from './application/use-cases/monitor';
import { NotificationService } from './application/use-cases/notifications';
import { JobQueries } from './application/use-cases/jobs';
import { DatabaseService } from './application/use-cases/database';
import { ServerHealthService } from './application/use-cases/server-health';
import { UpgradeService } from './application/use-cases/upgrade';
import { SelfUpdateService } from './application/use-cases/self-update';
import { EventBus } from './application/events';
import { DnsGateway, GithubGateway, OffsiteGateway, ProxmoxGateway, ProxyGateway, ShellGateway } from './application/gateways';
import { WriteGuard } from './application/guard';
import { JobEngine } from './application/jobs/engine';
import type { ExternalApis } from './application/ports';
import { Redactor } from './application/redactor';
import type { ForgeServices } from './application/services';
import { SettingsService } from './application/settings';
import { GithubClient } from './infrastructure/clients/github';
import { NpmClient } from './infrastructure/clients/npm';
import { UserFacingError } from '$lib/domain/errors';
import { OvhClient } from './infrastructure/clients/ovh';
import { DohResolver, NetworkProbe } from './infrastructure/clients/probe';
import { ProxmoxClient } from './infrastructure/clients/proxmox';
import { generateForgeKeyPair, SshClient } from './infrastructure/clients/ssh';
import { getConfig } from './infrastructure/config';
import { SecretBox } from './infrastructure/crypto/secret-box';
import { openDatabase } from './infrastructure/db/client';
import { AccountRepo, AuditRepo, AuthRepo, DomainRepo, JobRepo, NotificationRepo, ProjectRepo, ResourceRepo, SettingsRepo, SpaceRepo, UptimeRepo } from './infrastructure/db/repositories';
import { createFakeApis } from './infrastructure/mock/fake-apis';
import { seedMockDatabase } from './infrastructure/mock/seed';
import { resetWorld } from './infrastructure/mock/world';
import { exportPublicKey, importProvisioning } from './application/provisioning';
import { OffsiteBackupService } from './application/use-cases/offsite';
import { SleepService } from './application/use-cases/sleep';
import { AutoDeployService } from './application/use-cases/auto-deploy';
import { startWakeServer } from './infrastructure/wake/server';
import { ResticClient } from './infrastructure/clients/restic';
import { createHmac } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/** Mot de passe du dépôt restic, dérivé de la clé maître : la garder suffit pour tout relire. */
export function offsitePassword(masterKey: Buffer): string {
	return createHmac('sha256', masterKey).update('forge-offsite-restic-v1').digest('base64url');
}

export interface Forge extends ForgeServices {
	offsite: OffsiteBackupService;
	sleep: SleepService;
	engine: JobEngine;
	auth: AuthService;
	audit: AuditRepo;
	accounts: AccountService;
	dashboard: DashboardService;
	wizard: WizardService;
	projects: ProjectService;
	connections: ConnectionTester;
	jobs: JobQueries;
	database: DatabaseService;
	health: ServerHealthService;
	upgrade: UpgradeService;
	selfUpdate: SelfUpdateService;
	spaces: SpaceService;
	monitor: MonitorService;
	notifications: NotificationService;
	isDryRun(): boolean;
	setDryRun(value: boolean): void;
	resetMock(): void;
}

/**
 * Construit les clients réels à partir des réglages. Chaque client est mis en cache avec
 * l'empreinte de sa configuration : un changement (URL, jeton, CA…) en reconstruit un
 * neuf, avec son propre dispatcher TLS — jamais l'ancien.
 */
function liveApis(settings: SettingsService, accounts: AccountService, masterKey: Buffer): () => ExternalApis {
	let cache: Partial<Record<keyof ExternalApis, { sig: string; client: object }>> = {};
	settings.onChange(() => {
		cache = {};
	});
	const lazy = <K extends keyof ExternalApis, C>(key: K, config: () => C, make: (c: C) => ExternalApis[K]): ExternalApis[K] =>
		new Proxy({} as ExternalApis[K], {
			get(_t, prop) {
				const cfg = config();
				const sig = JSON.stringify(cfg);
				if (cache[key]?.sig !== sig) {
					try {
						cache[key] = { sig, client: make(cfg) as object };
					} catch (err) {
						// Client non configuré : chaque appel échoue proprement (promesse rejetée).
						delete cache[key];
						return () => Promise.reject(err);
					}
				}
				const target = cache[key]?.client as object;
				const v = Reflect.get(target, prop);
				return typeof v === 'function' ? v.bind(target) : v;
			}
		});
	// Clients des comptes supplémentaires : un par configuration, reconstruits si les comptes changent.
	let extras = new Map<string, object>();
	accounts.onChange(() => {
		extras = new Map();
	});
	const extraClient = <C extends object>(sig: string, make: () => C): C => {
		let c = extras.get(sig);
		if (!c) extras.set(sig, (c = make()));
		return c as C;
	};
	const apis: ExternalApis = {
		offsite: lazy(
			'offsite',
			() => ({
				endpoint: settings.get('offsite.endpoint'),
				bucket: settings.get('offsite.bucket'),
				accessKeyId: settings.get('offsite.accessKeyId'),
				secretAccessKey: settings.get('offsite.secretAccessKey'),
				password: offsitePassword(masterKey)
			}),
			(c) => new ResticClient(c)
		),
		proxmox: lazy(
			'proxmox',
			() => ({
				url: settings.get('proxmox.url'),
				node: settings.get('proxmox.node'),
				tokenId: settings.get('proxmox.tokenId'),
				tokenSecret: settings.get('proxmox.tokenSecret'),
				caCert: settings.get('proxmox.caCert').trim()
			}),
			(c) => new ProxmoxClient(c)
		),
		github: routeGithub(
			lazy(
				'github',
				() => settings.get('github.token'),
				(t) => new GithubClient(t)
			),
			() =>
				accounts.githubAccounts().map((a) => ({
					owner: a.owner,
					api: extraClient(`gh:${a.token}`, () => new GithubClient(a.token))
				}))
		),
		ovh: routeOvh(
			lazy(
				'ovh',
				() => ({
					endpoint: settings.get('ovh.endpoint'),
					appKey: settings.get('ovh.appKey'),
					appSecret: settings.get('ovh.appSecret'),
					consumerKey: settings.get('ovh.consumerKey')
				}),
				(c) => new OvhClient(c)
			),
			() =>
				accounts.ovhAccounts().map((a) => ({
					label: a.label,
					api: extraClient(`ovh:${JSON.stringify(a.config)}`, () => new OvhClient(a.config))
				}))
		),
		npm: lazy(
			'npm',
			() => ({
				url: settings.get('npm.url'),
				identity: settings.get('npm.identity'),
				secret: settings.get('npm.secret')
			}),
			(c) => new NpmClient(c)
		),
		ssh: new SshClient(),
		probe: new NetworkProbe(),
		resolver: new DohResolver()
	};
	return () => apis;
}

function build(): Forge {
	const config = getConfig();
	const { db, sqlite } = openDatabase(config.databasePath);
	const cipher = new SecretBox(config.masterKey);

	const projects = new ProjectRepo(db);
	const domains = new DomainRepo(db);
	const jobs = new JobRepo(db);
	const resources = new ResourceRepo(db);
	const settings = new SettingsService(new SettingsRepo(db), cipher);

	const accounts = new AccountService(new AccountRepo(db), cipher);
	const redactor = new Redactor();
	const refreshSecrets = () => redactor.add(...settings.secretValues(), ...accounts.secretValues());
	refreshSecrets();
	settings.onChange(refreshSecrets);

	const isDryRun = () => {
		if (config.mode === 'mock') {
			const o = settings.get('runtime.dryRun');
			if (o === 'true') return true;
			if (o === 'false') return false;
		}
		return config.dryRunDefault;
	};
	const guard = new WriteGuard(isDryRun, (s) => redactor.redact(s));

	accounts.onChange(refreshSecrets);
	const fake = config.mode === 'mock' ? createFakeApis() : null;
	const apis = fake ? () => fake : liveApis(settings, accounts, config.masterKey);

	const lookup = {
		// Le CT de build fait partie des cibles SSH autorisées (créé et possédé par Forge).
		forgeIps: () => [...projects.list().map((p) => p.ip), settings.get('builder.ip')].filter((x): x is string => !!x),
		forgeRepos: () => projects.list().map((p) => `${p.repoOwner}/${p.repoName}`)
	};
	const deps = {
		apis,
		guard,
		settings,
		ownership: resources,
		projects: lookup,
		githubOwners: () => [settings.get('github.owner'), ...accounts.githubOwners()]
	};

	const services: ForgeServices = {
		config,
		settings,
		redactor,
		guard,
		cipher,
		events: new EventBus(),
		proxmox: new ProxmoxGateway(deps),
		github: new GithubGateway(deps),
		dns: new DnsGateway(deps),
		proxy: new ProxyGateway(deps),
		shell: new ShellGateway(deps, (ip, fp) => {
			if (ip === settings.get('builder.ip')) {
				if (!settings.get('builder.hostKey')) settings.set({ 'builder.hostKey': fp });
				return;
			}
			const p = projects.list().find((x) => x.ip === ip);
			if (p && !p.sshHostKey) projects.update(p.id, { sshHostKey: fp });
		}),
		githubOwners: deps.githubOwners,
		ovhCredentialsFor: async (zone) => {
			const main = { endpoint: settings.get('ovh.endpoint'), appKey: settings.get('ovh.appKey'), appSecret: settings.get('ovh.appSecret'), consumerKey: settings.get('ovh.consumerKey') };
			if (config.mode === 'mock') return main;
			const candidates = [main, ...accounts.ovhAccounts().map((a) => a.config)].filter((c) => c.appKey && c.appSecret && c.consumerKey);
			for (const c of candidates) {
				const zones = await new OvhClient(c).listZones().catch(() => [] as string[]);
				if (zones.some((z) => z.toLowerCase() === zone.toLowerCase())) return c;
			}
			throw new UserFacingError(`Aucun compte OVH connecté ne gère la zone ${zone}.`);
		},
		probe: () => apis().probe,
		resolver: () => apis().resolver,
		repos: { projects, domains, jobs, resources, spaces: new SpaceRepo(db), uptime: new UptimeRepo(db), notifications: new NotificationRepo(db) }
	};

	if (config.mode === 'mock') {
		resetWorld();
		seedMockDatabase(services, db);
		if (!settings.has('ssh.privateKey')) {
			const kp = generateForgeKeyPair('forge-demo');
			settings.set({
				'ssh.privateKey': kp.privateKey,
				'ssh.publicKey': kp.publicKey,
				'letsencrypt.email': 'bastien@bastiengrnt.fr'
			});
		}
	}

	if (config.mode === 'live') {
		// Clé SSH générée au premier démarrage : bootstrap.sh la lit (updates/forge.pub) pour le template 900.
		if (!settings.has('ssh.privateKey')) {
			const kp = generateForgeKeyPair('forge');
			settings.set({
				'ssh.privateKey': kp.privateKey,
				'ssh.publicKey': kp.publicKey
			});
			console.log('[forge] Clé SSH générée (Réglages → Clé SSH).');
		}
		const publish = () => void exportPublicKey(config.updatesDir, settings.get('ssh.publicKey')).catch((err) => console.warn(`[forge] forge.pub : ${err}`));
		publish();
		settings.onChange(publish);
		// Réglages Proxmox déposés par infra/02 (provision.json) : importés puis supprimés.
		const provision = () =>
			void importProvisioning(config.updatesDir, settings)
				.then((keys) => keys?.length && console.log(`[forge] Réglages importés depuis infra/02 : ${keys.join(', ')}`))
				.catch((err) => console.warn(`[forge] ${err instanceof Error ? err.message : err}`));
		provision();
		setInterval(provision, 10_000).unref();
	}

	const engine = new JobEngine(services);
	const auth = new AuthService(new AuthRepo(db), {
		exposeSetupToken: config.mode === 'mock'
	});
	if (auth.needsSetup()) auth.setupToken();
	else if (config.adminReset) {
		const token = auth.issueAdminResetFromHost();
		if (token)
			console.log(
				`\n[forge] ━━ Réinitialisation du mot de passe admin ━━\n[forge] Ouvrez /reset/${token} (valable 30 min, une seule fois).\n[forge] Retirez ensuite FORGE_ADMIN_RESET du .env.\n`
			);
	}

	const offsite = new OffsiteBackupService(services, {
		gateway: new OffsiteGateway(deps),
		snapshotForgeDb: async () => {
			const tmp = join(tmpdir(), `forge-snap-${process.pid}-${Date.now()}.db`);
			try {
				await sqlite.backup(tmp);
				return await readFile(tmp);
			} finally {
				await rm(tmp, { force: true });
			}
		},
		verifyForgeDb: (data) => {
			const tmp = join(tmpdir(), `forge-verify-${process.pid}-${Date.now()}.db`);
			try {
				writeFileSync(tmp, data, { mode: 0o600 });
				const check = new Database(tmp, { readonly: true });
				try {
					const r = check.pragma('integrity_check', { simple: true });
					const tables = check.prepare("select count(*) as n from sqlite_master where type = 'table'").get() as { n: number };
					return r !== 'ok' ? String(r) : tables.n === 0 ? 'aucune table' : null;
				} finally {
					check.close();
				}
			} catch (err) {
				return err instanceof Error ? err.message : String(err);
			} finally {
				rmSync(tmp, { force: true });
			}
		}
	});

	const sleep = new SleepService(services);
	engine.setBeforeJob((projectId) => sleep.beforeJob(projectId));
	const wizard = new WizardService(services, auth);
	const notifications = new NotificationService(services);
	notifications.listenToJobs();
	const monitor = new MonitorService(services, notifications);
	const forge: Forge = {
		...services,
		engine,
		auth,
		audit: new AuditRepo(db),
		accounts,
		dashboard: new DashboardService(services),
		wizard,
		projects: new ProjectService(services, engine, auth, wizard),
		connections: new ConnectionTester(services),
		jobs: new JobQueries(services),
		database: new DatabaseService(services, engine),
		offsite,
		sleep,
		health: new ServerHealthService(services, offsite),
		upgrade: new UpgradeService(services, engine),
		selfUpdate: new SelfUpdateService(services, engine),
		spaces: new SpaceService(services),
		monitor,
		notifications,
		isDryRun,
		setDryRun(value: boolean) {
			if (config.mode !== 'mock') throw new Error('Le DRY_RUN ne se change que par variable d’environnement en mode live.');
			settings.set({ 'runtime.dryRun': value ? 'true' : 'false' });
		},
		resetMock() {
			if (config.mode !== 'mock') throw new Error('Réservé au mode mock.');
			if (engine.isBusy()) throw new Error('Un job est en cours : attendez sa fin.');
			resetWorld();
			seedMockDatabase(services, db);
		}
	};
	engine.start();
	// Caches de build : ramenés à 2 Go dès qu'ils les dépassent (5 min après le démarrage, puis toutes les 6 h).
	const pruneCaches = () =>
		void forge.health
			.autoPruneCaches((projectId) => engine.enqueue({ type: 'prune_cache', projectId, params: { keepRecent: true } }).id)
			.then((slugs) => slugs.length && console.log(`[forge] Nettoyage du cache de build lancé : ${slugs.join(', ')}`))
			.catch((err) => console.warn(`[forge] Nettoyage des caches de build : ${err instanceof Error ? err.message : err}`));
	setTimeout(pruneCaches, 5 * 60_000).unref();
	setInterval(pruneCaches, 6 * 3600_000).unref();
	// Entretien de l'hôte (jobs de sauvegarde, CT critiques, priorités CPU) : 2 min après le démarrage, puis toutes les 6 h.
	const maintain = () =>
		void forge.health
			.autoMaintain()
			.then(({ done, failed }) => {
				if (done.length) console.log(`[forge] Entretien : ${done.join(' ; ')}`);
				if (failed.length) console.warn(`[forge] Entretien en échec : ${failed.join(' ; ')}`);
			})
			.catch((err) => console.warn(`[forge] Entretien : ${err instanceof Error ? err.message : err}`));
	setTimeout(maintain, 2 * 60_000).unref();
	setInterval(maintain, 6 * 3600_000).unref();
	// Sauvegardes hors serveur (R2) : vérifié toutes les heures, ne fait que ce qui est dû.
	const offsiteTick = () =>
		void forge.offsite
			.tick()
			.then((done) => done.length && console.log(`[forge] Sauvegarde hors serveur : ${done.join(', ')}`))
			.catch((err) => console.warn(`[forge] Sauvegarde hors serveur : ${err instanceof Error ? err.message : err}`));
	setTimeout(offsiteTick, 3 * 60_000).unref();
	setInterval(offsiteTick, 3600_000).unref();
	// Déploiement automatique à chaque commit (projets sur le CT de build) et extinction du CT de build inutilisé.
	const autoDeploy = new AutoDeployService(services, engine);
	setInterval(() => void autoDeploy.tick().catch((err) => console.warn(`[auto-deploy] ${err instanceof Error ? err.message : err}`)), AutoDeployService.CHECK_EVERY_MS).unref();
	// Serveurs de dev : mise en veille après inactivité, réveil par la page d'attente (port à part).
	setInterval(() => void sleep.tick().catch((err) => console.warn(`[veille] ${err instanceof Error ? err.message : err}`)), SleepService.CHECK_EVERY_MS).unref();
	// Surveillance des sites (lecture seule) : un relevé par domaine et par minute.
	if (config.mode === 'mock') monitor.seedDemoHistory();
	setInterval(() => void monitor.tick().catch((err) => console.warn(`[surveillance] ${err instanceof Error ? err.message : err}`)), MonitorService.CHECK_EVERY_MS).unref();
	if (config.mode === 'live') {
		const g = globalThis as unknown as Record<symbol, { close(): void } | undefined>;
		g[WAKE_KEY]?.close();
		g[WAKE_KEY] = startWakeServer({
			npmIp: () => {
				try {
					return new URL(settings.get('npm.url')).hostname;
				} catch {
					return '';
				}
			},
			projectForHost: (host) => {
				const d = domains.byFqdn(host);
				const p = d ? projects.get(d.projectId) : undefined;
				return p ? { id: p.id, name: p.name, sleeping: !!p.sleepingSince } : null;
			},
			wake: (id) => sleep.wakeFromVisit(id),
			wakeError: (id) => sleep.wakeErrorFor(id)
		});
	}
	console.log(`[forge] Démarré en mode ${config.mode.toUpperCase()} — DRY_RUN ${isDryRun() ? 'ACTIVÉ' : 'désactivé'} — base ${config.databasePath}`);
	if (config.masterKeyIsDevFallback) console.warn('[forge] ⚠ FORGE_MASTER_KEY absente : clé de démonstration utilisée (mode mock uniquement).');
	return forge;
}

const KEY = Symbol.for('forge.container');
const WAKE_KEY = Symbol.for('forge.wake-server');

export function forge(): Forge {
	const g = globalThis as unknown as Record<symbol, Forge | undefined>;
	g[KEY] ??= build();
	return g[KEY] as Forge;
}

// En dev, un changement de ce module (ou de ses dépendances) reconstruit le conteneur.
if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		const g = globalThis as unknown as Record<symbol, Forge | undefined>;
		g[KEY]?.engine.stop();
		g[KEY] = undefined;
	});
}

/**
 * Racine de composition : construit tous les services une seule fois (singleton
 * conservé à travers le rechargement à chaud) selon le mode live ou mock.
 */
import { ConnectionTester } from './application/use-cases/connections';
import { DashboardService } from './application/use-cases/dashboard';
import { WizardService } from './application/use-cases/wizard';
import { ProjectService } from './application/use-cases/projects';
import { AuthService } from './application/use-cases/auth';
import { JobQueries } from './application/use-cases/jobs';
import { DatabaseService } from './application/use-cases/database';
import { ServerHealthService } from './application/use-cases/server-health';
import { UpgradeService } from './application/use-cases/upgrade';
import { EventBus } from './application/events';
import { DnsGateway, GithubGateway, ProxmoxGateway, ProxyGateway, ShellGateway } from './application/gateways';
import { WriteGuard } from './application/guard';
import { JobEngine } from './application/jobs/engine';
import type { ExternalApis } from './application/ports';
import { Redactor } from './application/redactor';
import type { ForgeServices } from './application/services';
import { SettingsService } from './application/settings';
import { GithubClient } from './infrastructure/clients/github';
import { NpmClient } from './infrastructure/clients/npm';
import { OvhClient } from './infrastructure/clients/ovh';
import { DohResolver, NetworkProbe } from './infrastructure/clients/probe';
import { ProxmoxClient } from './infrastructure/clients/proxmox';
import { generateForgeKeyPair, SshClient } from './infrastructure/clients/ssh';
import { getConfig } from './infrastructure/config';
import { SecretBox } from './infrastructure/crypto/secret-box';
import { openDatabase } from './infrastructure/db/client';
import { AuthRepo, DomainRepo, JobRepo, ProjectRepo, ResourceRepo, SettingsRepo } from './infrastructure/db/repositories';
import { createFakeApis } from './infrastructure/mock/fake-apis';
import { seedMockDatabase } from './infrastructure/mock/seed';
import { resetWorld } from './infrastructure/mock/world';

export interface Forge extends ForgeServices {
	engine: JobEngine;
	auth: AuthService;
	dashboard: DashboardService;
	wizard: WizardService;
	projects: ProjectService;
	connections: ConnectionTester;
	jobs: JobQueries;
	database: DatabaseService;
	health: ServerHealthService;
	upgrade: UpgradeService;
	isDryRun(): boolean;
	setDryRun(value: boolean): void;
	resetMock(): void;
}

/**
 * Construit les clients réels à partir des réglages. Chaque client est mis en cache avec
 * l'empreinte de sa configuration : un changement (URL, jeton, CA…) en reconstruit un
 * neuf, avec son propre dispatcher TLS — jamais l'ancien.
 */
function liveApis(settings: SettingsService): () => ExternalApis {
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
	const apis: ExternalApis = {
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
		github: lazy('github', () => settings.get('github.token'), (t) => new GithubClient(t)),
		ovh: lazy(
			'ovh',
			() => ({
				endpoint: settings.get('ovh.endpoint'),
				appKey: settings.get('ovh.appKey'),
				appSecret: settings.get('ovh.appSecret'),
				consumerKey: settings.get('ovh.consumerKey')
			}),
			(c) => new OvhClient(c)
		),
		npm: lazy('npm', () => ({ url: settings.get('npm.url'), identity: settings.get('npm.identity'), secret: settings.get('npm.secret') }), (c) => new NpmClient(c)),
		ssh: new SshClient(),
		probe: new NetworkProbe(),
		resolver: new DohResolver()
	};
	return () => apis;
}

function build(): Forge {
	const config = getConfig();
	const { db } = openDatabase(config.databasePath);
	const cipher = new SecretBox(config.masterKey);

	const projects = new ProjectRepo(db);
	const domains = new DomainRepo(db);
	const jobs = new JobRepo(db);
	const resources = new ResourceRepo(db);
	const settings = new SettingsService(new SettingsRepo(db), cipher);

	const redactor = new Redactor();
	const refreshSecrets = () => redactor.add(...settings.secretValues());
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

	const fake = config.mode === 'mock' ? createFakeApis() : null;
	const apis = fake ? () => fake : liveApis(settings);

	const lookup = {
		forgeIps: () => projects.list().map((p) => p.ip).filter((x): x is string => !!x),
		forgeRepos: () => projects.list().map((p) => `${p.repoOwner}/${p.repoName}`)
	};
	const deps = { apis, guard, settings, ownership: resources, projects: lookup };

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
			const p = projects.list().find((x) => x.ip === ip);
			if (p && !p.sshHostKey) projects.update(p.id, { sshHostKey: fp });
		}),
		probe: () => apis().probe,
		resolver: () => apis().resolver,
		repos: { projects, domains, jobs, resources }
	};

	if (config.mode === 'mock') {
		resetWorld();
		seedMockDatabase(services, db);
		if (!settings.has('ssh.privateKey')) {
			const kp = generateForgeKeyPair('forge-demo');
			settings.set({ 'ssh.privateKey': kp.privateKey, 'ssh.publicKey': kp.publicKey, 'letsencrypt.email': 'bastien@bastiengrnt.fr' });
		}
	}

	const engine = new JobEngine(services);
	const auth = new AuthService(new AuthRepo(db), { exposeSetupToken: config.mode === 'mock' });
	if (auth.needsSetup()) auth.setupToken();

	const forge: Forge = {
		...services,
		engine,
		auth,
		dashboard: new DashboardService(services),
		wizard: new WizardService(services),
		projects: new ProjectService(services, engine),
		connections: new ConnectionTester(services),
		jobs: new JobQueries(services),
		database: new DatabaseService(services, engine),
		health: new ServerHealthService(services),
		upgrade: new UpgradeService(services, engine),
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
	console.log(`[forge] Démarré en mode ${config.mode.toUpperCase()} — DRY_RUN ${isDryRun() ? 'ACTIVÉ' : 'désactivé'} — base ${config.databasePath}`);
	if (config.masterKeyIsDevFallback) console.warn('[forge] ⚠ FORGE_MASTER_KEY absente : clé de démonstration utilisée (mode mock uniquement).');
	return forge;
}

const KEY = Symbol.for('forge.container');

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

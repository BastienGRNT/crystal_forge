/**
 * Données de démonstration (mode mock uniquement) : un projet actif et un projet
 * dont le déploiement a échoué à l'étape DNS, pour tester « Reprendre » / « Annuler ».
 */
import type { ForgeServices } from '$server/application/services';
import { envAad } from '$server/application/services';
import type { Db } from '../db/client';
import { domains, jobLogs, jobs, jobSteps, projects, resources } from '../db/schema';
import { FIREWALL_OPTIONS } from '$lib/domain/firewall';
import { firewallPlan } from '$server/application/jobs/steps/firewall';
import { world } from './world';
import { createHash } from 'node:crypto';

const DEMO_ENV = `# Base de données
DB_USER=notes
DB_PASSWORD=demo-mot-de-passe-123
DATABASE_URL=postgres://notes:demo-mot-de-passe-123@db:5432/notes

# Application
ORIGIN=https://notes.bastiengrnt.fr
SESSION_SECRET=une-valeur-tres-secrete-de-demo
`;

/**
 * Le monde simulé vit en mémoire : à chaque démarrage, les données métier de la base
 * mock sont remises à zéro pour rester cohérentes avec lui (compte admin, sessions et
 * réglages sont conservés).
 */
export function seedMockDatabase(s: ForgeServices, db: Db): void {
	const { repos, cipher, settings } = s;
	// Réglages propres à une installation, alignés sur le monde simulé (ceux déjà saisis sont gardés).
	const demoSettings = {
		'network.publicIp': '51.68.180.212',
		'proxmox.node': 'ns3125740',
		'github.owner': 'BastienGRNT',
		'safety.protectedCtids': '100,101,401,402,403,404',
		'network.reservedIps': '10.10.10.1,10.10.10.2,10.10.10.15,10.10.10.50,10.10.10.200'
	} as const;
	settings.set(Object.fromEntries(Object.entries(demoSettings).filter(([k]) => !settings.has(k as keyof typeof demoSettings))));
	db.delete(jobLogs).run();
	db.delete(resources).run();
	db.delete(jobSteps).run();
	db.delete(jobs).run();
	db.delete(domains).run();
	db.delete(projects).run();

	// --- Projet actif ---------------------------------------------------------------------
	const notes = repos.projects.create({
		slug: 'crystal-notes',
		name: 'Crystal Notes',
		repoOwner: 'BastienGRNT',
		repoName: 'crystal-notes',
		branch: 'main',
		workdir: '.',
		deployMode: 'compose',
		composeFile: 'docker-compose.yml',
		appService: 'app',
		appPort: 3000,
		postDeploy: 'npx drizzle-kit migrate',
		dbService: 'db',
		dbKind: 'postgres',
		firewallAppliedAt: Date.now() - 5 * 86400_000,
		size: 'S',
		ctid: 500,
		ip: '10.10.10.60',
		status: 'active'
	});
	repos.projects.update(notes.id, { envEncrypted: cipher.encrypt(DEMO_ENV, envAad(notes.id)), envUpdatedAt: Date.now() - 5 * 86400_000 });
	repos.domains.create({ projectId: notes.id, fqdn: 'notes.bastiengrnt.fr', zone: 'bastiengrnt.fr', subdomain: 'notes', mode: 'ovh', status: 'active', sslStatus: 'valid', sslExpiresAt: Date.now() + 85 * 86400_000 });

	world().firewalls.set(500, { options: { ...FIREWALL_OPTIONS }, rules: firewallPlan(s, notes).map((r, i) => ({ ...r, pos: i })) });

	const t0 = Date.now() - 5 * 86400_000;
	const deploy = db
		.insert(jobs)
		.values({ projectId: notes.id, type: 'deploy', status: 'succeeded', dryRun: false, params: '{"confirmations":{"workflow":true}}', startedAt: t0, finishedAt: t0 + 154_000, createdAt: t0, updatedAt: t0 + 154_000 })
		.returning()
		.get();
	const steps: [string, number][] = [
		['ct', 38],
		['firewall', 2],
		['runner', 19],
		['secrets', 3],
		['workflow', 4],
		['dns', 41],
		['npm', 27],
		['pipeline', 20]
	];
	let t = t0;
	steps.forEach(([key, dur], i) => {
		db.insert(jobSteps).values({ jobId: deploy.id, key, position: i, status: 'succeeded', state: '{}', startedAt: t, finishedAt: t + dur * 1000 }).run();
		t += dur * 1000;
	});
	const L = (ms: number, level: 'info' | 'success' | 'warn' | 'debug', stepKey: string | null, message: string) =>
		db.insert(jobLogs).values({ jobId: deploy.id, stepKey, level, message, ts: t0 + ms }).run();
	L(0, 'info', null, 'Job « Déploiement initial » créé.');
	L(200, 'info', 'ct', '▶ Conteneur LXC');
	L(900, 'success', 'ct', 'Attribué : CT 500 — IP 10.10.10.60');
	L(1200, 'info', 'ct', '→ Proxmox · Cloner le template 900 → CT 500 « crystal-notes » (pool forge, clone complet sur local)');
	L(31000, 'success', 'ct', 'CT 500 cloné depuis le template 900.');
	L(38000, 'success', 'ct', 'SSH opérationnel (clé d’hôte SHA256:q3Vb…).');
	L(39500, 'success', 'firewall', 'Pare-feu appliqué : seul NPM (10.10.10.2) atteint le port 3000, le reste du bridge est bloqué.');
	L(59000, 'success', 'runner', 'Runner « crystal-notes » en ligne (#21), labels : self-hosted, forge, crystal-notes.');
	L(62000, 'success', 'secrets', 'Secret ENV_FILE écrit (5 variable(s), valeurs jamais journalisées).');
	L(66000, 'success', 'workflow', 'Workflow commité (a1b2c3d). Le push déclenche déjà un premier run.');
	L(107000, 'success', 'dns', 'notes.bastiengrnt.fr résout vers 51.68.180.212.');
	L(134000, 'success', 'npm', 'notes.bastiengrnt.fr → http://10.10.10.60:3000 (proxy host #9, certificat #9).');
	L(153000, 'success', 'pipeline', 'https://notes.bastiengrnt.fr répond HTTP 200 en 87 ms.');
	L(154000, 'success', null, 'Job terminé avec succès.');

	const own = (type: Parameters<typeof repos.resources.record>[0]['type'], externalId: string | number, meta: Record<string, unknown> = {}) =>
		repos.resources.record({ type, externalId, projectId: notes.id, jobId: deploy.id, meta });
	own('pve_ct', 500, { hostname: 'crystal-notes' });
	own('gh_runner', 'BastienGRNT/crystal-notes:21', { name: 'crystal-notes' });
	own('gh_secret', 'BastienGRNT/crystal-notes:ENV_FILE');
	for (const v of ['FORGE_COMPOSE_FILE', 'FORGE_WORKDIR', 'FORGE_APP_SERVICE', 'FORGE_APP_PORT', 'FORGE_POST_DEPLOY', 'FORGE_DB_SERVICE', 'FORGE_DB_KIND']) own('gh_variable', `BastienGRNT/crystal-notes:${v}`);
	const wf = world().repos.get('bastiengrnt/crystal-notes')?.files.get('.github/workflows/forge-deploy.yml') ?? '';
	own('gh_workflow', 'BastienGRNT/crystal-notes:.github/workflows/forge-deploy.yml', { sha: createHash('sha1').update(wf).digest('hex'), commitSha: 'a1b2c3d', branch: 'main' });
	own('ovh_record', 'bastiengrnt.fr:1006', { fqdn: 'notes.bastiengrnt.fr' });
	own('npm_proxy_host', 9, { fqdn: 'notes.bastiengrnt.fr' });
	own('npm_certificate', 9, { fqdn: 'notes.bastiengrnt.fr' });

	// --- Projet en échec (étape DNS) ------------------------------------------------------
	const lab = repos.projects.create({
		slug: 'lab-api',
		name: 'Lab API',
		repoOwner: 'BastienGRNT',
		repoName: 'tiny-api',
		branch: 'main',
		workdir: '.',
		deployMode: 'dockerfile',
		composeFile: null,
		appService: 'app',
		appPort: 8080,
		postDeploy: null,
		size: 'S',
		ctid: 501,
		ip: '10.10.10.62',
		status: 'error'
	});
	repos.projects.update(lab.id, { envEncrypted: cipher.encrypt('PORT=8080\nLOG_LEVEL=info\nAPI_KEY=demo-cle-api-456\n', envAad(lab.id)), envUpdatedAt: Date.now() - 3600_000 });
	repos.domains.create({ projectId: lab.id, fqdn: 'lab.bastiengrnt.fr', zone: 'bastiengrnt.fr', subdomain: 'lab', mode: 'ovh', status: 'pending' });

	const f0 = Date.now() - 50 * 60_000;
	const failed = db
		.insert(jobs)
		.values({
			projectId: lab.id,
			type: 'deploy',
			status: 'failed',
			dryRun: false,
			params: '{"confirmations":{"workflow":true}}',
			error: '[OVH] POST /domain/zone/bastiengrnt.fr/record : délai dépassé (https://eu.api.ovh.com/1.0/domain/zone/bastiengrnt.fr/record)',
			startedAt: f0,
			finishedAt: f0 + 95_000,
			createdAt: f0,
			updatedAt: f0 + 95_000
		})
		.returning()
		.get();
	const fsteps: [string, 'succeeded' | 'failed' | 'pending' | 'skipped', number][] = [
		['ct', 'succeeded', 36],
		['firewall', 'skipped', 0],
		['runner', 'succeeded', 19],
		['secrets', 'succeeded', 3],
		['workflow', 'succeeded', 5],
		['dns', 'failed', 32],
		['npm', 'pending', 0],
		['pipeline', 'pending', 0]
	];
	t = f0;
	fsteps.forEach(([key, status, dur], i) => {
		db.insert(jobSteps)
			.values({
				jobId: failed.id,
				key,
				position: i,
				status,
				state: key === 'workflow' ? '{"commitSha":"mock-lab"}' : '{}',
				error: status === 'failed' ? '[OVH] POST /domain/zone/bastiengrnt.fr/record : délai dépassé' : null,
				startedAt: status === 'pending' ? null : t,
				finishedAt: status === 'pending' ? null : t + dur * 1000
			})
			.run();
		t += dur * 1000;
	});
	const F = (ms: number, level: 'info' | 'success' | 'warn' | 'error', stepKey: string | null, message: string) =>
		db.insert(jobLogs).values({ jobId: failed.id, stepKey, level, message, ts: f0 + ms }).run();
	F(0, 'info', null, 'Job « Déploiement initial » créé.');
	F(800, 'warn', 'ct', '10.10.10.61 répond au ping/ARP sans être déclarée dans un CT : ignorée.');
	F(900, 'success', 'ct', 'Attribué : CT 501 — IP 10.10.10.62');
	F(36000, 'success', 'ct', '✔ Conteneur LXC — terminé en 35.2 s');
	F(36200, 'info', 'firewall', 'Pare-feu par CT désactivé à l’époque : étape ignorée (appliquez-le depuis Serveur ou l’onglet Conteneur).');
	F(55000, 'success', 'runner', 'Runner « lab-api » en ligne (#22), labels : self-hosted, forge, lab-api.');
	F(63000, 'success', 'workflow', 'Workflow commité (9f8e7d6). Le push déclenche déjà un premier run.');
	F(64000, 'info', 'dns', '▶ DNS');
	F(95000, 'error', 'dns', '✖ DNS : [OVH] POST /domain/zone/bastiengrnt.fr/record : délai dépassé (https://eu.api.ovh.com/1.0/domain/zone/bastiengrnt.fr/record)');

	const ownLab = (type: Parameters<typeof repos.resources.record>[0]['type'], externalId: string | number, meta: Record<string, unknown> = {}) =>
		repos.resources.record({ type, externalId, projectId: lab.id, jobId: failed.id, meta });
	ownLab('pve_ct', 501, { hostname: 'lab-api' });
	ownLab('gh_runner', 'BastienGRNT/tiny-api:22', { name: 'lab-api' });
	ownLab('gh_secret', 'BastienGRNT/tiny-api:ENV_FILE');
	for (const v of ['FORGE_COMPOSE_FILE', 'FORGE_WORKDIR', 'FORGE_APP_SERVICE', 'FORGE_APP_PORT']) ownLab('gh_variable', `BastienGRNT/tiny-api:${v}`);
	ownLab('gh_workflow', 'BastienGRNT/tiny-api:.github/workflows/forge-deploy.yml', { sha: 'mock', commitSha: '9f8e7d6', branch: 'main' });
}

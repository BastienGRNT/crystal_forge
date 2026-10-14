/**
 * Monde simulé du mode mock : une copie en mémoire de l'infrastructure réelle
 * (relevée le 2026-10-14). Toutes les API simulées lisent et écrivent ici, ce qui
 * permet de dérouler un déploiement complet sans toucher à rien de réel.
 */
import { createHash } from 'node:crypto';
import { generateWorkflow } from '$lib/domain/workflow';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

export interface FakeGuest {
	vmid: number;
	name: string;
	type: 'lxc' | 'qemu';
	status: 'running' | 'stopped';
	pool: string | null;
	template: boolean;
	tags: string[];
	config: Record<string, string | number>;
	cores: number;
	memMb: number;
	diskGb: number;
	diskUsedGb: number;
	baseCpu: number;
	baseMemRatio: number;
	startedAt: number;
}

export interface FakeTask {
	upid: string;
	startedAt: number;
	durationMs: number;
	lines: string[];
	exitstatus: string;
	done: boolean;
	onDone?: () => void;
}

export interface FakeRunStep {
	name: string;
	durationMs: number;
	/** Étape conditionnelle (if: vars.…) dont la variable est vide : ignorée par GitHub. */
	skipped?: boolean;
}

export interface FakeRun {
	id: number;
	runNumber: number;
	repo: string;
	event: string;
	headSha: string;
	branch: string;
	commitMessage: string;
	actor: string;
	createdAt: number;
	startedAt: number | null;
	steps: FakeRunStep[];
	failAtStep: number | null;
	runnerLabel: string;
}

export interface FakeRepo {
	owner: string;
	name: string;
	private: boolean;
	defaultBranch: string;
	description: string;
	pushedAt: number;
	files: Map<string, string>;
	secrets: Map<string, number>;
	variables: Map<string, string>;
	runners: { id: number; name: string; labels: string[]; online: boolean }[];
	runs: FakeRun[];
	commits: number;
}

export interface FakeRecord {
	id: number;
	zone: string;
	fieldType: string;
	subDomain: string;
	target: string;
	ttl: number;
	/** Moment où le record devient visible dans le DNS public. */
	visibleAt: number;
}

export interface FakeNpmHost {
	id: number;
	domainNames: string[];
	forwardHost: string;
	forwardPort: number;
	certificateId: number;
}

export interface FakeNpmCert {
	id: number;
	domainNames: string[];
	expiresOn: string;
}

export interface FakeBackup {
	volid: string;
	vmid: number;
	ctime: number;
	size: number;
}

export interface FakeFwRule {
	pos: number;
	type: string;
	action: string;
	source?: string;
	dest?: string;
	proto?: string;
	dport?: string;
	comment?: string;
	enable?: number;
}

export interface FakeTable {
	schema: string;
	name: string;
	columns: string[];
	rows: string[][];
}

export interface FakeDbBackup {
	name: string;
	size: number;
	mtime: number;
}

export interface FakeWorld {
	createdAt: number;
	nextUpid: number;
	nextRunId: number;
	nextRecordId: number;
	nextNpmId: number;
	nextRunnerId: number;
	guests: Map<number, FakeGuest>;
	tasks: Map<string, FakeTask>;
	backups: FakeBackup[];
	repos: Map<string, FakeRepo>;
	zones: Map<string, FakeRecord[]>;
	npmHosts: FakeNpmHost[];
	npmCerts: FakeNpmCert[];
	/** IP qui répondent au ping sans être déclarées dans un CT (démonstration du contrôle actif). */
	ghostIps: Set<string>;
	ghKeyPair: { publicKey: string; privateKey: string } | null;
	clusterFirewall: Record<string, string | number>;
	firewalls: Map<number, { options: Record<string, string | number>; rules: FakeFwRule[] }>;
	backupJobs: { id: string; enabled: boolean; schedule: string; vmid: string | null; all: boolean; storage: string | null }[];
	/** Bases simulées, par nom de CT. */
	databases: Map<string, FakeTable[]>;
	/** Dumps SQL simulés sur les CT, par slug de projet. */
	dbBackups: Map<string, FakeDbBackup[]>;
	/** CT où les mises à jour de sécurité automatiques sont activées. */
	unattended: Set<number>;
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);

/** Petite base de démonstration (notes, utilisateurs, tags, migrations drizzle). */
export function demoTables(seedName: string): FakeTable[] {
	const titles = ['Courses de la semaine', 'Idées Forge', 'Recette crêpes', 'Réunion lundi', 'Lire « Designing Data-Intensive Applications »', 'Config Proxmox', 'Vacances 2027', 'Bug pagination', 'Liste cadeaux', 'Notes Tailscale', 'Migrations Postgres', 'Todo week-end'];
	const users = [
		['1', 'bastien@bastiengrnt.fr', 'Bastien', iso(200 * 86400_000)],
		['2', 'demo@bastiengrnt.fr', 'Compte démo', iso(90 * 86400_000)],
		['3', 'lea@example.fr', 'Léa', iso(12 * 86400_000)]
	];
	const notes = Array.from({ length: 137 }, (_, i) => [
		String(i + 1),
		String((i % 3) + 1),
		`${titles[i % titles.length]}${i >= titles.length ? ` #${Math.floor(i / titles.length) + 1}` : ''}`,
		i % 4 === 0 ? 'Texte avec, une virgule et des "guillemets"' : `Contenu de la note ${i + 1}`,
		i % 5 === 0 ? 't' : 'f',
		iso((137 - i) * 3 * 3600_000)
	]);
	const tags = ['perso', 'travail', 'urgent', 'idée', 'infra'].map((t, i) => [String(i + 1), t]);
	return [
		{ schema: 'public', name: 'users', columns: ['id', 'email', 'name', 'created_at'], rows: users },
		{ schema: 'public', name: 'notes', columns: ['id', 'user_id', 'title', 'body', 'pinned', 'created_at'], rows: notes },
		{ schema: 'public', name: 'tags', columns: ['id', 'name'], rows: tags },
		{ schema: 'public', name: 'note_tags', columns: ['note_id', 'tag_id'], rows: notes.slice(0, 60).map((n, i) => [n[0] as string, String((i % 5) + 1)]) },
		{
			schema: 'drizzle',
			name: '__drizzle_migrations',
			columns: ['id', 'hash', 'created_at'],
			rows: ['0000_init', '0001_tags', '0002_pinned', '0003_search'].map((h, i) => [String(i + 1), `${h}-${seedName.length}${i}a9f`, String(Date.now() - (40 - i * 9) * 86400_000)])
		}
	];
}

function ct(
	vmid: number,
	name: string,
	ip: string,
	opts: Partial<FakeGuest> & { port?: number } = {}
): FakeGuest {
	const cores = opts.cores ?? 2;
	const memMb = opts.memMb ?? 2048;
	const diskGb = opts.diskGb ?? 10;
	return {
		vmid,
		name,
		type: 'lxc',
		status: opts.status ?? 'running',
		pool: opts.pool ?? null,
		template: opts.template ?? false,
		tags: opts.tags ?? [],
		cores,
		memMb,
		diskGb,
		diskUsedGb: opts.diskUsedGb ?? diskGb * 0.45,
		baseCpu: opts.baseCpu ?? 0.03,
		baseMemRatio: opts.baseMemRatio ?? 0.55,
		startedAt: Date.now() - 1000 * 3600 * 24 * 12,
		config: {
			hostname: name,
			arch: 'amd64',
			ostype: 'ubuntu',
			cores,
			memory: memMb,
			swap: opts.config?.swap ?? 2048,
			rootfs: `local:${vmid}/vm-${vmid}-disk-0.raw,size=${diskGb}G`,
			net0: `name=eth0,bridge=nat,gw=10.10.10.1,hwaddr=BC:24:11:${vmid.toString(16).padStart(6, '0').replace(/(..)(..)(..)/, '$1:$2:$3').toUpperCase()},ip=${ip}/24,type=veth`,
			unprivileged: 1,
			features: 'nesting=1',
			onboot: opts.template ? 0 : 1,
			...(opts.template ? { template: 1 } : {}),
			...(opts.config ?? {})
		}
	};
}

const sha = (s: string) => createHash('sha1').update(s).digest('hex');

function legacyWorkflow(name: string, composeFile: string, migrate: boolean): string {
	return `name: Deploy ${name}
on:
  push:
    branches: [ "main" ]
jobs:
  deploy:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - name: Créer le fichier .env
        run: |
          cat <<EOF > .env
          DB_USER=\${{ secrets.DB_USER }}
          DB_PASSWORD=\${{ secrets.DB_PASSWORD }}
          EOF
      - run: docker compose -f ${composeFile} up -d --build --remove-orphans
${migrate ? `      - run: docker compose -f ${composeFile} exec -T app sh -c "npx drizzle-kit migrate"\n` : ''}      - run: docker image prune -f
`;
}

const COMPOSE = `services:
  app:
    build: .
    env_file: .env
    ports:
      - "3000:3000"
    restart: unless-stopped
    depends_on: [db]
  db:
    image: postgres:17
    env_file: .env
    volumes:
      - pgdata:/var/lib/postgresql/data
    restart: unless-stopped
volumes:
  pgdata:
`;

const COMPOSE_MIGRATE = `services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: \${DB_USER}
      POSTGRES_PASSWORD: \${DB_PASSWORD:?mot de passe requis}
      POSTGRES_DB: \${DB_NAME:-app}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${DB_USER}"]
      interval: 5s
    restart: unless-stopped
  migrate:
    build: .
    env_file: .env
    command: npx drizzle-kit migrate
    depends_on:
      db:
        condition: service_healthy
    restart: "no"
  app:
    build: .
    env_file: .env
    ports:
      - "3000:3000"
    depends_on:
      migrate:
        condition: service_completed_successfully
    restart: unless-stopped
volumes:
  pgdata:
`;

const ENV_EXAMPLE = `# Base de données (service « db »)
DB_USER=app
# Mot de passe Postgres
DB_PASSWORD=changeme
DB_NAME=app
DATABASE_URL=postgres://app:changeme@db:5432/app

# URL publique de l'application
ORIGIN=http://localhost:3000
PORT=3000

# Secret de signature des sessions
SESSION_SECRET=
# Clé API du service d'e-mails (Brevo)
BREVO_API_KEY=
LOG_LEVEL=info # debug, info, warn
`;

/** Reconstitue un workflow Forge v1 (sans marqueur de version ni sauvegarde de la base). */
function workflowV1(v2: string): string {
	return v2
		.replace(/^# forge-workflow-version: \d+\n/m, '')
		.replace(/^# Si FORGE_DB_SERVICE.*\n^#.*\n/m, '')
		.replace(/^ {6}FORGE_DB_(SERVICE|KIND):.*\n/gm, '')
		.replace(/ {6}- name: Sauvegarder la base[\s\S]*?(?=\n {6}- name: Construire)/, '')
		.replace(/\n{3,}/g, '\n\n');
}

function repo(name: string, files: Record<string, string>, opts: Partial<FakeRepo> = {}): FakeRepo {
	return {
		owner: 'BastienGRNT',
		name,
		private: opts.private ?? true,
		defaultBranch: opts.defaultBranch ?? 'main',
		description: opts.description ?? '',
		pushedAt: opts.pushedAt ?? Date.now() - Math.floor(Math.random() * 30) * 86400_000,
		files: new Map(Object.entries(files)),
		secrets: opts.secrets ?? new Map(),
		variables: opts.variables ?? new Map(),
		runners: opts.runners ?? [],
		runs: opts.runs ?? [],
		commits: 42
	};
}

const RUN_STEPS: FakeRunStep[] = [
	{ name: 'Set up job', durationMs: 1200 },
	{ name: 'Récupérer le code', durationMs: 1500 },
	{ name: 'Écrire le fichier .env', durationMs: 600 },
	{ name: 'Sauvegarder la base (avant déploiement)', durationMs: 1400 },
	{ name: 'Construire et démarrer', durationMs: 6500 },
	{ name: 'Post-déploiement', durationMs: 1800 },
	{ name: 'Nettoyer les images inutilisées', durationMs: 900 },
	{ name: 'Complete job', durationMs: 400 }
];

/** Étapes du workflow qui ne tournent que si leur variable de dépôt est définie. */
const CONDITIONAL_STEPS: Record<string, string> = {
	'Sauvegarder la base (avant déploiement)': 'FORGE_DB_SERVICE',
	'Post-déploiement': 'FORGE_POST_DEPLOY'
};

/** Étapes d'un nouveau run, comme GitHub les exécuterait avec ces variables de dépôt. */
export function runSteps(variables: Map<string, string>): FakeRunStep[] {
	return RUN_STEPS.map((s) => {
		const v = CONDITIONAL_STEPS[s.name];
		return v && !variables.get(v) ? { ...s, durationMs: 100, skipped: true } : s;
	});
}

function pastRun(id: number, repoName: string, label: string, daysAgo: number, conclusion: 'success' | 'failure', message: string): FakeRun {
	const created = Date.now() - daysAgo * 86400_000;
	return {
		id,
		runNumber: id % 1000,
		repo: repoName,
		event: 'push',
		headSha: sha(`${repoName}-${id}`),
		branch: 'main',
		commitMessage: message,
		actor: 'BastienGRNT',
		createdAt: created,
		startedAt: created + 2000,
		steps: RUN_STEPS,
		failAtStep: conclusion === 'failure' ? 3 : null,
		runnerLabel: label
	};
}

function record(id: number, zone: string, fieldType: string, subDomain: string, target: string): FakeRecord {
	return { id, zone, fieldType, subDomain, target, ttl: 3600, visibleAt: 0 };
}

function seed(): FakeWorld {
	const guests = new Map<number, FakeGuest>();
	const add = (g: FakeGuest) => guests.set(g.vmid, g);
	add(ct(100, 'CT100', '10.10.10.2', { cores: 1, memMb: 1024, diskGb: 8, baseCpu: 0.02, baseMemRatio: 0.48, tags: ['npm'] }));
	add(ct(101, 'modele-dotnet-runner', '10.10.10.200', { status: 'stopped', template: true, diskGb: 10 }));
	add(ct(401, 'pharmagaia', '10.10.10.41', { baseCpu: 0.06, baseMemRatio: 0.62 }));
	add(ct(402, 'crystalwallet', '10.10.10.42', { baseCpu: 0.04, baseMemRatio: 0.71 }));
	add(ct(403, 'crystalmiaou', '10.10.10.43', { baseCpu: 0.02, baseMemRatio: 0.58 }));
	add(ct(404, 'crystalbourse', '10.10.10.44', { baseCpu: 0.11, baseMemRatio: 0.77 }));
	add(ct(150, 'forge', '10.10.10.15', { cores: 1, memMb: 1024, diskGb: 8, baseMemRatio: 0.32, tags: ['forge-app'] }));
	add(
		ct(900, 'tpl-docker-runner', '10.10.10.59', {
			status: 'stopped',
			template: true,
			pool: 'forge',
			diskGb: 6,
			tags: ['forge-template'],
			config: { net0: 'name=eth0,bridge=nat,ip=manual,type=veth', features: 'nesting=1,keyctl=1', swap: 512, protection: 1 }
		})
	);
	// Projet de démonstration déjà déployé par Forge.
	// Disque presque plein : démonstration de l'alerte et de l'agrandissement.
	add(ct(500, 'crystal-notes', '10.10.10.60', { pool: 'forge', cores: 1, memMb: 1024, diskGb: 8, diskUsedGb: 6.9, tags: ['forge'], baseMemRatio: 0.44 }));
	// Projet de démonstration dont le déploiement a échoué à l'étape DNS.
	add(ct(501, 'lab-api', '10.10.10.62', { pool: 'forge', cores: 1, memMb: 1024, diskGb: 8, tags: ['forge'], baseMemRatio: 0.21 }));

	const repos = new Map<string, FakeRepo>();
	const addRepo = (r: FakeRepo) => repos.set(`${r.owner}/${r.name}`.toLowerCase(), r);
	addRepo(
		repo(
			'crystal_bourse',
			{
				'docker-compose.prod.yml': COMPOSE,
				'docker-compose.yml': COMPOSE,
				Dockerfile: 'FROM node:24-alpine\n',
				'package.json': '{}',
				'.github/workflows/deploy.yml': legacyWorkflow('Crystal Bourse', 'docker-compose.prod.yml', true)
			},
			{
				description: 'Suivi de portefeuille boursier',
				runners: [{ id: 11, name: 'crystalbourse', labels: ['self-hosted', 'Linux', 'X64'], online: true }],
				runs: [pastRun(8001, 'crystal_bourse', 'self-hosted', 0.3, 'success', 'feat: alertes de cours')]
			}
		)
	);
	addRepo(
		repo(
			'crystal_wallet',
			{ 'docker-compose.prod.yml': COMPOSE, Dockerfile: 'FROM node:24-alpine\n', '.github/workflows/deploy.yml': legacyWorkflow('Crystal Wallet', 'docker-compose.prod.yml', true) },
			{
				description: 'Gestion de budget',
				runners: [{ id: 12, name: 'crystalwallet', labels: ['self-hosted', 'Linux', 'X64'], online: true }],
				runs: [pastRun(8002, 'crystal_wallet', 'self-hosted', 2, 'success', 'fix: arrondi des montants')]
			}
		)
	);
	addRepo(
		repo(
			'crystal_miaou',
			{ 'docker-compose.prod.yml': COMPOSE, Dockerfile: 'FROM node:24-alpine\n', '.github/workflows/deploy.yml': legacyWorkflow('Crystal Miaou', 'docker-compose.prod.yml', false) },
			{
				description: 'Le site des chats',
				runners: [{ id: 13, name: 'crystalmiaou', labels: ['self-hosted', 'Linux', 'X64'], online: true }],
				runs: [pastRun(8003, 'crystal_miaou', 'self-hosted', 9, 'failure', 'feat: galerie')]
			}
		)
	);
	addRepo(
		repo(
			'pharmagaia',
			{ 'package.json': '{"name":"pharmagaia"}', 'svelte.config.js': '', '.github/workflows/deploy.yml': legacyWorkflow('Pharmagaia', 'n/a', false) },
			{
				description: 'SvelteKit — Node natif',
				runners: [{ id: 14, name: 'pharmagaia', labels: ['self-hosted', 'Linux', 'X64'], online: true }],
				runs: [pastRun(8004, 'pharmagaia', 'self-hosted', 1, 'success', 'feat: ordonnances en ligne')]
			}
		)
	);
	addRepo(
		repo(
			'crystal-notes',
			{
				'docker-compose.yml': COMPOSE,
				Dockerfile: 'FROM node:24-alpine\n',
				'.env.example': ENV_EXAMPLE + '# Ajoutée dans la v2 : recherche plein texte\nMEILI_MASTER_KEY=\n',
				// Workflow v1 (généré par une ancienne version de Forge) : démonstration de « Mettre à niveau ».
				'.github/workflows/forge-deploy.yml': workflowV1(generateWorkflow({ slug: 'crystal-notes', branch: 'main', mode: 'compose', ctid: 500 }))
			},
			{
				description: 'Prise de notes (déployé par Forge)',
				secrets: new Map([['ENV_FILE', Date.now() - 5 * 86400_000]]),
				variables: new Map([
					['FORGE_COMPOSE_FILE', 'docker-compose.yml'],
					['FORGE_WORKDIR', '.'],
					['FORGE_APP_SERVICE', 'app'],
					['FORGE_APP_PORT', '3000'],
					['FORGE_POST_DEPLOY', 'npx drizzle-kit migrate'],
					['FORGE_DB_SERVICE', 'db']
				]),
				runners: [{ id: 21, name: 'crystal-notes', labels: ['self-hosted', 'Linux', 'X64', 'forge', 'crystal-notes'], online: true }],
				runs: [
					pastRun(9001, 'crystal-notes', 'crystal-notes', 5, 'success', 'chore(forge): ajoute le workflow de déploiement Forge'),
					pastRun(9002, 'crystal-notes', 'crystal-notes', 3, 'failure', 'feat: éditeur markdown'),
					pastRun(9003, 'crystal-notes', 'crystal-notes', 3, 'success', 'fix: migration manquante'),
					pastRun(9004, 'crystal-notes', 'crystal-notes', 1, 'success', 'feat: recherche plein texte')
				]
			}
		)
	);
	addRepo(
		repo(
			'tiny-api',
			{
				Dockerfile: 'FROM golang:1.25\n',
				'go.mod': 'module tiny',
				'.github/workflows/forge-deploy.yml': generateWorkflow({ slug: 'lab-api', branch: 'main', mode: 'dockerfile', ctid: 501 })
			},
			{
				description: 'Petite API Go (Dockerfile seul)',
				secrets: new Map([['ENV_FILE', Date.now() - 3600_000]]),
				variables: new Map([
					['FORGE_COMPOSE_FILE', '.forge-compose.yml'],
					['FORGE_WORKDIR', '.'],
					['FORGE_APP_SERVICE', 'app'],
					['FORGE_APP_PORT', '8080']
				]),
				runners: [{ id: 22, name: 'lab-api', labels: ['self-hosted', 'Linux', 'X64', 'forge', 'lab-api'], online: true }],
				runs: [pastRun(9101, 'tiny-api', 'lab-api', 0.04, 'success', 'chore(forge): ajoute le workflow de déploiement Forge')]
			}
		)
	);
	addRepo(
		repo(
			'forge-test-app',
			{ 'docker-compose.yml': COMPOSE_MIGRATE, Dockerfile: 'FROM node:24-alpine\n', '.env.example': ENV_EXAMPLE, 'README.md': '# Test' },
			{ description: 'Dépôt jetable pour tester Forge', pushedAt: Date.now() - 3600_000 }
		)
	);
	addRepo(
		repo(
			'monorepo-demo',
			{ 'app/docker-compose.yml': COMPOSE, 'app/Dockerfile': 'FROM node:24-alpine\n', 'app/.env.example': 'DB_USER=app\nDB_PASSWORD=\nAPP_URL=\nJWT_SECRET=changeme\n', 'docs/README.md': '', 'README.md': '' },
			{ description: 'Application dans le sous-dossier ./app' }
		)
	);
	addRepo(repo('dotfiles', { '.zshrc': '', 'README.md': '' }, { private: false, description: 'Mes dotfiles' }));
	addRepo(
		repo('crystal_forge', { Dockerfile: 'FROM node:24\n', 'docker-compose.yml': COMPOSE, 'package.json': '{}' }, { description: 'Forge — mini-PaaS Proxmox' })
	);

	const zones = new Map<string, FakeRecord[]>();
	let rid = 1000;
	const z1 = 'bastiengrnt.fr';
	zones.set(z1, [
		record(rid++, z1, 'A', '', '51.68.180.212'),
		record(rid++, z1, 'CNAME', 'www', 'bastiengrnt.fr.'),
		record(rid++, z1, 'A', 'nginx', '51.68.180.212'),
		record(rid++, z1, 'A', 'wallet', '51.68.180.212'),
		record(rid++, z1, 'A', 'miaou', '51.68.180.212'),
		record(rid++, z1, 'A', 'bourse', '51.68.180.212'),
		record(rid++, z1, 'A', 'notes', '51.68.180.212'),
		record(rid++, z1, 'MX', '', '1 mx1.mail.ovh.net.'),
		record(rid++, z1, 'TXT', '', '"v=spf1 include:mx.ovh.com ~all"'),
		record(rid++, z1, 'NS', '', 'dns200.anycast.me.')
	]);
	const z2 = 'pharmagaia.com';
	zones.set(z2, [
		record(rid++, z2, 'A', '', '51.68.180.212'),
		record(rid++, z2, 'A', 'ordonnance', '51.68.180.212'),
		record(rid++, z2, 'A', 'comptoir', '51.68.180.212'),
		record(rid++, z2, 'A', 'pharmazon', '51.68.180.212'),
		record(rid++, z2, 'CNAME', 'www', 'pharmagaia.com.'),
		record(rid++, z2, 'MX', '', '1 mx1.mail.ovh.net.')
	]);

	const certExp = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().replace('T', ' ').slice(0, 19);
	const hosts: [string, string, number, number][] = [
		['pharmagaia.com', '10.10.10.41', 3000, 61],
		['ordonnance.pharmagaia.com', '10.10.10.41', 3000, 48],
		['comptoir.pharmagaia.com', '10.10.10.41', 3000, 47],
		['pharmazon.pharmagaia.com', '10.10.10.41', 3000, 12],
		['nginx.bastiengrnt.fr', '10.10.10.2', 81, 70],
		['wallet.bastiengrnt.fr', '10.10.10.42', 3000, 55],
		['miaou.bastiengrnt.fr', '10.10.10.43', 3000, 33],
		['bourse.bastiengrnt.fr', '10.10.10.44', 3001, 80],
		['notes.bastiengrnt.fr', '10.10.10.60', 3000, 85]
	];
	const npmHosts: FakeNpmHost[] = [];
	const npmCerts: FakeNpmCert[] = [];
	hosts.forEach(([domain, ip, port, days], i) => {
		npmCerts.push({ id: i + 1, domainNames: [domain], expiresOn: certExp(days) });
		npmHosts.push({ id: i + 1, domainNames: [domain], forwardHost: ip, forwardPort: port, certificateId: i + 1 });
	});

	return {
		createdAt: Date.now(),
		nextUpid: 1,
		nextRunId: 10_000,
		nextRecordId: 5000,
		nextNpmId: 100,
		nextRunnerId: 100,
		guests,
		tasks: new Map(),
		backups: [
			{ volid: 'local:backup/vzdump-lxc-500-2026_10_13-03_30_02.tar.zst', vmid: 500, ctime: Date.now() / 1000 - 86400, size: 412 * MiB },
			...[100, 401, 402, 404].map((vmid) => ({ volid: `local:backup/vzdump-lxc-${vmid}-auto.tar.zst`, vmid, ctime: Date.now() / 1000 - 11 * 3600, size: 900 * MiB })),
			// CT 403 : dernière sauvegarde trop ancienne (démonstration de l'alerte).
			{ volid: 'local:backup/vzdump-lxc-403-old.tar.zst', vmid: 403, ctime: Date.now() / 1000 - 3 * 86400, size: 610 * MiB }
		],
		repos,
		zones,
		npmHosts,
		npmCerts,
		ghostIps: new Set(['10.10.10.61']),
		ghKeyPair: null,
		// Pare-feu du datacenter désactivé, comme sur un Proxmox fraîchement installé.
		clusterFirewall: { enable: 0 },
		unattended: new Set(),
		firewalls: new Map([[500, { options: { enable: 1, policy_in: 'DROP', policy_out: 'ACCEPT', ipfilter: 1, macfilter: 1 }, rules: [] }]]),
		backupJobs: [{ id: 'forge-prod-daily', enabled: true, schedule: '03:30', vmid: '100,401,402,403,404', all: false, storage: 'local' }],
		databases: new Map([['crystal-notes', demoTables('crystal-notes')]]),
		dbBackups: new Map([
			[
				'crystal-notes',
				[
					{ name: backupStamp(1 * 86400_000, 'pre-deploy-4f1c2ab'), size: 48_213, mtime: Date.now() - 86400_000 },
					{ name: backupStamp(3 * 86400_000, 'pre-deploy-9e03d71'), size: 45_870, mtime: Date.now() - 3 * 86400_000 },
					{ name: backupStamp(3.2 * 86400_000, 'manual'), size: 45_102, mtime: Date.now() - 3.2 * 86400_000 }
				]
			]
		])
	};
}

function backupStamp(msAgo: number, suffix: string): string {
	const d = new Date(Date.now() - msAgo);
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${suffix}.sql.gz`;
}

const KEY = Symbol.for('forge.mock.world');

/** Monde unique, conservé à travers le rechargement à chaud de Vite. */
export function world(): FakeWorld {
	const g = globalThis as unknown as Record<symbol, FakeWorld | undefined>;
	if (!g[KEY]) g[KEY] = seed();
	return g[KEY] as FakeWorld;
}

export function resetWorld(): void {
	(globalThis as unknown as Record<symbol, FakeWorld | undefined>)[KEY] = seed();
}

export const HOST = { cpus: 8, memTotal: 15.5 * GiB, baseUsed: 9.3 * GiB, rootfsTotal: 400 * GiB, rootfsUsed: 131 * GiB };
export { GiB, MiB };

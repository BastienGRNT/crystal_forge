import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = sql`(unixepoch() * 1000)`;
const timestamps = {
	createdAt: integer('created_at', { mode: 'number' }).notNull().default(now),
	updatedAt: integer('updated_at', { mode: 'number' }).notNull().default(now)
};

export const projects = sqliteTable(
	'projects',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		slug: text('slug').notNull(),
		name: text('name').notNull(),
		repoOwner: text('repo_owner').notNull(),
		repoName: text('repo_name').notNull(),
		branch: text('branch').notNull().default('main'),
		workdir: text('workdir').notNull().default('.'),
		deployMode: text('deploy_mode', { enum: ['compose', 'dockerfile'] }).notNull(),
		composeFile: text('compose_file'),
		appService: text('app_service').notNull().default('app'),
		appPort: integer('app_port').notNull().default(3000),
		postDeploy: text('post_deploy'),
		/** Service compose de la base (onglet Base de données, dump avant déploiement). */
		dbService: text('db_service'),
		dbKind: text('db_kind', { enum: ['postgres', 'mysql', 'mariadb', 'redis', 'mongo'] }),
		/** Dernière application du pare-feu Proxmox du CT. */
		firewallAppliedAt: integer('firewall_applied_at'),
		size: text('size', { enum: ['S', 'M', 'L'] }).notNull().default('M'),
		/** Taille personnalisée (null = valeur du préréglage). */
		cores: integer('cores'),
		memoryMb: integer('memory_mb'),
		diskGb: integer('disk_gb'),
		ctid: integer('ctid'),
		ip: text('ip'),
		/** .env chiffré (AES-256-GCM). */
		envEncrypted: text('env_encrypted'),
		envUpdatedAt: integer('env_updated_at'),
		/** Empreinte SHA-256 de la clé d'hôte SSH (TOFU). */
		sshHostKey: text('ssh_host_key'),
		status: text('status', { enum: ['draft', 'deploying', 'active', 'error', 'deleting', 'deleted'] })
			.notNull()
			.default('draft'),
		...timestamps
	},
	(t) => [uniqueIndex('projects_slug_idx').on(t.slug)]
);

export const domains = sqliteTable(
	'domains',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		projectId: integer('project_id')
			.notNull()
			.references(() => projects.id),
		fqdn: text('fqdn').notNull(),
		zone: text('zone'),
		subdomain: text('subdomain').notNull().default(''),
		/** ovh : géré via l'API OVH ; manual : enregistrement A créé à la main. */
		mode: text('mode', { enum: ['ovh', 'manual'] }).notNull(),
		status: text('status', { enum: ['pending', 'dns_ok', 'active', 'error', 'removing'] })
			.notNull()
			.default('pending'),
		sslStatus: text('ssl_status'),
		sslExpiresAt: integer('ssl_expires_at'),
		...timestamps
	},
	(t) => [uniqueIndex('domains_fqdn_idx').on(t.fqdn), index('domains_project_idx').on(t.projectId)]
);

export const jobs = sqliteTable(
	'jobs',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		projectId: integer('project_id').references(() => projects.id),
		type: text('type').notNull(),
		status: text('status', {
			enum: ['queued', 'running', 'awaiting_input', 'failed', 'succeeded', 'cancelled', 'rolling_back', 'rolled_back']
		})
			.notNull()
			.default('queued'),
		dryRun: integer('dry_run', { mode: 'boolean' }).notNull().default(true),
		/** Paramètres non secrets du job (JSON). */
		params: text('params').notNull().default('{}'),
		error: text('error'),
		startedAt: integer('started_at'),
		finishedAt: integer('finished_at'),
		...timestamps
	},
	(t) => [index('jobs_project_idx').on(t.projectId), index('jobs_status_idx').on(t.status)]
);

export const jobSteps = sqliteTable(
	'job_steps',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		jobId: integer('job_id')
			.notNull()
			.references(() => jobs.id),
		key: text('key').notNull(),
		position: integer('position').notNull(),
		status: text('status', { enum: ['pending', 'running', 'awaiting_input', 'succeeded', 'failed', 'skipped'] })
			.notNull()
			.default('pending'),
		/** Sorties de l'étape (JSON) : ctid, upid, ids créés… pour la reprise idempotente. */
		state: text('state').notNull().default('{}'),
		error: text('error'),
		startedAt: integer('started_at'),
		finishedAt: integer('finished_at')
	},
	(t) => [index('job_steps_job_idx').on(t.jobId)]
);

export const jobLogs = sqliteTable(
	'job_logs',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		jobId: integer('job_id')
			.notNull()
			.references(() => jobs.id),
		stepKey: text('step_key'),
		ts: integer('ts').notNull(),
		level: text('level', { enum: ['debug', 'info', 'success', 'warn', 'error', 'dry'] }).notNull(),
		/** Message déjà passé par le masqueur de secrets. */
		message: text('message').notNull()
	},
	(t) => [index('job_logs_job_idx').on(t.jobId, t.id)]
);

/** Tout ce que Forge a créé à l'extérieur : seule base de la règle « ne touche que ce qu'il a créé ». */
export const resources = sqliteTable(
	'resources',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		projectId: integer('project_id').references(() => projects.id),
		jobId: integer('job_id').references(() => jobs.id),
		type: text('type', {
			enum: ['pve_ct', 'ovh_record', 'npm_proxy_host', 'npm_certificate', 'gh_runner', 'gh_secret', 'gh_variable', 'gh_workflow']
		}).notNull(),
		externalId: text('external_id').notNull(),
		meta: text('meta').notNull().default('{}'),
		createdAt: integer('created_at').notNull().default(now),
		deletedAt: integer('deleted_at')
	},
	(t) => [index('resources_type_idx').on(t.type, t.externalId), index('resources_project_idx').on(t.projectId)]
);

export const settings = sqliteTable('settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	isSecret: integer('is_secret', { mode: 'boolean' }).notNull().default(false),
	updatedAt: integer('updated_at').notNull().default(now)
});

export const admin = sqliteTable('admin', {
	id: integer('id').primaryKey(),
	passwordHash: text('password_hash').notNull(),
	updatedAt: integer('updated_at').notNull().default(now)
});

export const sessions = sqliteTable('sessions', {
	/** SHA-256 du jeton de session (le jeton lui-même n'est jamais stocké). */
	id: text('id').primaryKey(),
	expiresAt: integer('expires_at').notNull(),
	createdAt: integer('created_at').notNull().default(now),
	ip: text('ip'),
	userAgent: text('user_agent')
});

export type ProjectRow = typeof projects.$inferSelect;
export type DomainRow = typeof domains.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type JobStepRow = typeof jobSteps.$inferSelect;
export type JobLogRow = typeof jobLogs.$inferSelect;
export type ResourceRow = typeof resources.$inferSelect;
export type JobStatus = JobRow['status'];
export type StepStatus = JobStepRow['status'];
export type LogLevel = JobLogRow['level'];

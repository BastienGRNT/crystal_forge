import { and, asc, count, desc, eq, gt, inArray, isNull, lt, ne } from 'drizzle-orm';
import type { Db } from './client';
import {
	accounts,
	auditLog,
	domains,
	jobLogs,
	jobs,
	jobSteps,
	passwordResets,
	projectMembers,
	projects,
	resources,
	sessions,
	settings,
	users,
	type AccountRow,
	type DomainRow,
	type JobLogRow,
	type JobRow,
	type JobStatus,
	type JobStepRow,
	type LogLevel,
	type ProjectRow,
	type ResourceRow,
	type StepStatus,
	type UserRow
} from './schema';
import type { AccessLevel, Role } from '$lib/domain/access';
import type { OwnedResource, ResourceType } from '$lib/domain/safety-policy';

const ts = () => Date.now();

export type NewProject = typeof projects.$inferInsert;
export type NewDomain = typeof domains.$inferInsert;

export class ProjectRepo {
	constructor(private readonly db: Db) {}

	list(includeDeleted = false): ProjectRow[] {
		const q = this.db.select().from(projects);
		return (includeDeleted ? q : q.where(ne(projects.status, 'deleted'))).orderBy(desc(projects.createdAt)).all();
	}
	get(id: number): ProjectRow | undefined {
		return this.db.select().from(projects).where(eq(projects.id, id)).get();
	}
	bySlug(slug: string): ProjectRow | undefined {
		return this.db.select().from(projects).where(eq(projects.slug, slug)).get();
	}
	create(data: NewProject): ProjectRow {
		return this.db.insert(projects).values(data).returning().get();
	}
	update(id: number, data: Partial<NewProject>): ProjectRow {
		return this.db
			.update(projects)
			.set({ ...data, updatedAt: ts() })
			.where(eq(projects.id, id))
			.returning()
			.get();
	}
	/** IP et CTID réservés par des projets non supprimés (même si le CT n'existe pas encore). */
	reservedAllocations(): { ctids: number[]; ips: string[] } {
		const rows = this.db
			.select({ ctid: projects.ctid, ip: projects.ip })
			.from(projects)
			.where(ne(projects.status, 'deleted'))
			.all();
		return {
			ctids: rows.map((r) => r.ctid).filter((x): x is number => x !== null),
			ips: rows.map((r) => r.ip).filter((x): x is string => x !== null)
		};
	}
}

export class DomainRepo {
	constructor(private readonly db: Db) {}

	byProject(projectId: number): DomainRow[] {
		return this.db.select().from(domains).where(eq(domains.projectId, projectId)).orderBy(asc(domains.id)).all();
	}
	all(): DomainRow[] {
		return this.db.select().from(domains).all();
	}
	get(id: number): DomainRow | undefined {
		return this.db.select().from(domains).where(eq(domains.id, id)).get();
	}
	byFqdn(fqdn: string): DomainRow | undefined {
		return this.db.select().from(domains).where(eq(domains.fqdn, fqdn)).get();
	}
	create(data: NewDomain): DomainRow {
		return this.db.insert(domains).values(data).returning().get();
	}
	update(id: number, data: Partial<NewDomain>): void {
		this.db
			.update(domains)
			.set({ ...data, updatedAt: ts() })
			.where(eq(domains.id, id))
			.run();
	}
	delete(id: number): void {
		this.db.delete(domains).where(eq(domains.id, id)).run();
	}
}

export interface JobWithSteps extends JobRow {
	steps: JobStepRow[];
}

export class JobRepo {
	constructor(private readonly db: Db) {}

	create(input: { projectId: number | null; type: string; dryRun: boolean; params: unknown; steps: string[] }): JobWithSteps {
		return this.db.transaction((tx) => {
			const job = tx
				.insert(jobs)
				.values({
					projectId: input.projectId,
					type: input.type,
					dryRun: input.dryRun,
					params: JSON.stringify(input.params ?? {}),
					status: 'queued'
				})
				.returning()
				.get();
			const steps = input.steps.map((key, position) =>
				tx.insert(jobSteps).values({ jobId: job.id, key, position }).returning().get()
			);
			return { ...job, steps };
		});
	}
	get(id: number): JobWithSteps | undefined {
		const job = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
		if (!job) return undefined;
		return { ...job, steps: this.steps(id) };
	}
	steps(jobId: number): JobStepRow[] {
		return this.db.select().from(jobSteps).where(eq(jobSteps.jobId, jobId)).orderBy(asc(jobSteps.position)).all();
	}
	/** projectIds : ne garde que les jobs de ces projets (collaborateur) ; vide = aucun. */
	list(opts: { projectId?: number; projectIds?: number[]; limit?: number } = {}): JobRow[] {
		if (opts.projectIds && opts.projectIds.length === 0) return [];
		const q = this.db.select().from(jobs);
		const filtered = opts.projectIds
			? q.where(inArray(jobs.projectId, opts.projectIds))
			: opts.projectId !== undefined
				? q.where(eq(jobs.projectId, opts.projectId))
				: q;
		return filtered
			.orderBy(desc(jobs.id))
			.limit(opts.limit ?? 50)
			.all();
	}
	nextQueued(): JobRow | undefined {
		return this.db.select().from(jobs).where(eq(jobs.status, 'queued')).orderBy(asc(jobs.id)).get();
	}
	byStatus(statuses: JobStatus[]): JobRow[] {
		return this.db.select().from(jobs).where(inArray(jobs.status, statuses)).all();
	}
	activeForProject(projectId: number): JobRow | undefined {
		return this.db
			.select()
			.from(jobs)
			.where(and(eq(jobs.projectId, projectId), inArray(jobs.status, ['queued', 'running', 'awaiting_input', 'rolling_back'])))
			.get();
	}
	setStatus(id: number, status: JobStatus, extra: { error?: string | null } = {}): void {
		const patch: Partial<JobRow> = { status, updatedAt: ts() };
		if (status === 'running' || status === 'rolling_back') {
			patch.startedAt = ts();
			patch.finishedAt = null;
		}
		if (status === 'queued') patch.finishedAt = null;
		if (['failed', 'succeeded', 'cancelled', 'rolled_back'].includes(status)) patch.finishedAt = ts();
		if (extra.error !== undefined) patch.error = extra.error;
		this.db.update(jobs).set(patch).where(eq(jobs.id, id)).run();
	}
	updateParams(id: number, params: unknown): void {
		this.db
			.update(jobs)
			.set({ params: JSON.stringify(params), updatedAt: ts() })
			.where(eq(jobs.id, id))
			.run();
	}
	setStep(stepId: number, status: StepStatus, extra: { error?: string | null; state?: unknown } = {}): void {
		const patch: Partial<JobStepRow> = { status };
		if (status === 'running') patch.startedAt = ts();
		if (['succeeded', 'failed', 'skipped'].includes(status)) patch.finishedAt = ts();
		if (extra.error !== undefined) patch.error = extra.error;
		if (extra.state !== undefined) patch.state = JSON.stringify(extra.state);
		this.db.update(jobSteps).set(patch).where(eq(jobSteps.id, stepId)).run();
	}
	saveStepState(stepId: number, state: unknown): void {
		this.db
			.update(jobSteps)
			.set({ state: JSON.stringify(state) })
			.where(eq(jobSteps.id, stepId))
			.run();
	}
	addLog(jobId: number, stepKey: string | null, level: LogLevel, message: string): JobLogRow {
		return this.db.insert(jobLogs).values({ jobId, stepKey, level, message, ts: ts() }).returning().get();
	}
	logs(jobId: number, afterId = 0, limit = 5000): JobLogRow[] {
		return this.db
			.select()
			.from(jobLogs)
			.where(and(eq(jobLogs.jobId, jobId), gt(jobLogs.id, afterId)))
			.orderBy(asc(jobLogs.id))
			.limit(limit)
			.all();
	}
}

export class ResourceRepo {
	constructor(private readonly db: Db) {}

	record(input: { type: ResourceType; externalId: string | number; projectId: number | null; jobId: number | null; meta?: unknown }): ResourceRow {
		const existing = this.findActive(input.type, String(input.externalId));
		if (existing) return existing;
		return this.db
			.insert(resources)
			.values({
				type: input.type,
				externalId: String(input.externalId),
				projectId: input.projectId,
				jobId: input.jobId,
				meta: JSON.stringify(input.meta ?? {})
			})
			.returning()
			.get();
	}
	findActive(type: ResourceType, externalId: string): ResourceRow | undefined {
		return this.db
			.select()
			.from(resources)
			.where(and(eq(resources.type, type), eq(resources.externalId, externalId), isNull(resources.deletedAt)))
			.get();
	}
	active(filter: { type?: ResourceType; projectId?: number; jobId?: number } = {}): ResourceRow[] {
		const conds = [isNull(resources.deletedAt)];
		if (filter.type) conds.push(eq(resources.type, filter.type));
		if (filter.projectId !== undefined) conds.push(eq(resources.projectId, filter.projectId));
		if (filter.jobId !== undefined) conds.push(eq(resources.jobId, filter.jobId));
		return this.db
			.select()
			.from(resources)
			.where(and(...conds))
			.orderBy(asc(resources.id))
			.all();
	}
	owned(type?: ResourceType): OwnedResource[] {
		return this.active(type ? { type } : {}).map((r) => ({ type: r.type, externalId: r.externalId, projectId: r.projectId }));
	}
	updateMeta(type: ResourceType, externalId: string, meta: unknown): void {
		this.db
			.update(resources)
			.set({ meta: JSON.stringify(meta) })
			.where(and(eq(resources.type, type), eq(resources.externalId, externalId), isNull(resources.deletedAt)))
			.run();
	}
	markDeleted(type: ResourceType, externalId: string | number): void {
		this.db
			.update(resources)
			.set({ deletedAt: ts() })
			.where(and(eq(resources.type, type), eq(resources.externalId, String(externalId)), isNull(resources.deletedAt)))
			.run();
	}
}

export class SettingsRepo {
	constructor(private readonly db: Db) {}

	all(): { key: string; value: string; isSecret: boolean }[] {
		return this.db.select().from(settings).all();
	}
	get(key: string): { value: string; isSecret: boolean } | undefined {
		return this.db.select().from(settings).where(eq(settings.key, key)).get();
	}
	set(key: string, value: string, isSecret: boolean): void {
		this.db
			.insert(settings)
			.values({ key, value, isSecret, updatedAt: ts() })
			.onConflictDoUpdate({ target: settings.key, set: { value, isSecret, updatedAt: ts() } })
			.run();
	}
	delete(key: string): void {
		this.db.delete(settings).where(eq(settings.key, key)).run();
	}
}

export class AuthRepo {
	constructor(private readonly db: Db) {}

	// --- Utilisateurs ---
	userCount(): number {
		return this.db.select({ n: count() }).from(users).get()?.n ?? 0;
	}
	listUsers(): UserRow[] {
		return this.db.select().from(users).orderBy(asc(users.id)).all();
	}
	userById(id: number): UserRow | undefined {
		return this.db.select().from(users).where(eq(users.id, id)).get();
	}
	userByUsername(username: string): UserRow | undefined {
		return this.db.select().from(users).where(eq(users.username, username)).get();
	}
	firstAdmin(): UserRow | undefined {
		return this.db.select().from(users).where(eq(users.role, 'admin')).orderBy(asc(users.id)).get();
	}
	createUser(input: { username: string; passwordHash: string; role: Role }): UserRow {
		return this.db.insert(users).values(input).returning().get();
	}
	setPassword(userId: number, hash: string): void {
		this.db.update(users).set({ passwordHash: hash, updatedAt: ts() }).where(eq(users.id, userId)).run();
	}
	setDisabled(userId: number, disabled: boolean): void {
		this.db.update(users).set({ disabled, updatedAt: ts() }).where(eq(users.id, userId)).run();
	}
	deleteUser(userId: number): void {
		this.db.delete(users).where(eq(users.id, userId)).run();
	}

	// --- Droits par projet ---
	membershipsOf(userId: number): { projectId: number; level: AccessLevel }[] {
		return this.db.select({ projectId: projectMembers.projectId, level: projectMembers.level }).from(projectMembers).where(eq(projectMembers.userId, userId)).all();
	}
	allMemberships(): { userId: number; projectId: number; level: AccessLevel }[] {
		return this.db.select({ userId: projectMembers.userId, projectId: projectMembers.projectId, level: projectMembers.level }).from(projectMembers).all();
	}
	setMember(userId: number, projectId: number, level: AccessLevel): void {
		this.db
			.insert(projectMembers)
			.values({ userId, projectId, level })
			.onConflictDoUpdate({ target: [projectMembers.userId, projectMembers.projectId], set: { level } })
			.run();
	}
	removeMember(userId: number, projectId: number): void {
		this.db.delete(projectMembers).where(and(eq(projectMembers.userId, userId), eq(projectMembers.projectId, projectId))).run();
	}

	// --- Sessions ---
	createSession(idHash: string, userId: number, expiresAt: number, ip: string | null, userAgent: string | null): void {
		this.db.insert(sessions).values({ id: idHash, userId, expiresAt, ip, userAgent }).run();
	}
	getSession(idHash: string): { expiresAt: number; userId: number | null } | undefined {
		return this.db.select({ expiresAt: sessions.expiresAt, userId: sessions.userId }).from(sessions).where(eq(sessions.id, idHash)).get();
	}
	extendSession(idHash: string, expiresAt: number): void {
		this.db.update(sessions).set({ expiresAt }).where(eq(sessions.id, idHash)).run();
	}
	deleteSession(idHash: string): void {
		this.db.delete(sessions).where(eq(sessions.id, idHash)).run();
	}
	deleteSessionsOf(userId: number): void {
		this.db.delete(sessions).where(eq(sessions.userId, userId)).run();
	}
	purgeExpired(): void {
		this.db.delete(sessions).where(lt(sessions.expiresAt, ts())).run();
		this.db.delete(passwordResets).where(lt(passwordResets.expiresAt, ts())).run();
	}

	// --- Réinitialisation du mot de passe ---
	createReset(idHash: string, userId: number, expiresAt: number): void {
		this.db.delete(passwordResets).where(eq(passwordResets.userId, userId)).run();
		this.db.insert(passwordResets).values({ id: idHash, userId, expiresAt }).run();
	}
	getReset(idHash: string): { userId: number; expiresAt: number } | undefined {
		return this.db.select({ userId: passwordResets.userId, expiresAt: passwordResets.expiresAt }).from(passwordResets).where(eq(passwordResets.id, idHash)).get();
	}
	deleteResetsOf(userId: number): void {
		this.db.delete(passwordResets).where(eq(passwordResets.userId, userId)).run();
	}
}

export class AuditRepo {
	constructor(private readonly db: Db) {}

	add(entry: { userId: number | null; username: string; method: string; path: string; status: number; ip: string | null }): void {
		this.db.insert(auditLog).values(entry).run();
	}
	recent(limit = 100) {
		return this.db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(limit).all();
	}
}

export class AccountRepo {
	constructor(private readonly db: Db) {}

	list(kind?: AccountRow['kind']): AccountRow[] {
		const q = this.db.select().from(accounts);
		return (kind ? q.where(eq(accounts.kind, kind)) : q).orderBy(asc(accounts.id)).all();
	}
	get(id: number): AccountRow | undefined {
		return this.db.select().from(accounts).where(eq(accounts.id, id)).get();
	}
	create(data: { kind: AccountRow['kind']; label: string; owner: string | null; config: string }): AccountRow {
		return this.db.insert(accounts).values(data).returning().get();
	}
	update(id: number, data: { label?: string; owner?: string | null; config?: string }): void {
		this.db.update(accounts).set({ ...data, updatedAt: ts() }).where(eq(accounts.id, id)).run();
	}
	delete(id: number): void {
		this.db.delete(accounts).where(eq(accounts.id, id)).run();
	}
}

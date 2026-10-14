/** Vues sérialisables des jobs pour l'UI. */
import type { JobRow } from '$server/infrastructure/db/schema';
import { jobLabel, stepLabel } from '../jobs/definitions';
import type { PendingInput } from '../jobs/types';
import type { ForgeServices } from '../services';

const parse = (s: string): Record<string, unknown> => {
	try {
		return JSON.parse(s) as Record<string, unknown>;
	} catch {
		return {};
	}
};

export interface JobSummary {
	id: number;
	type: string;
	label: string;
	status: JobRow['status'];
	dryRun: boolean;
	error: string | null;
	createdAt: number;
	startedAt: number | null;
	finishedAt: number | null;
	project: { slug: string; name: string } | null;
	currentStep: string | null;
}

export interface StepView {
	id: number;
	key: string;
	label: string;
	status: string;
	error: string | null;
	startedAt: number | null;
	finishedAt: number | null;
	pendingInput: PendingInput | null;
	manualDns: { fqdn: string; ip: string }[] | null;
	runId: number | null;
}

export interface JobView extends JobSummary {
	steps: StepView[];
	resources: { type: string; externalId: string; meta: Record<string, unknown> }[];
	targetJobId: number | null;
}

export class JobQueries {
	constructor(private readonly s: ForgeServices) {}

	#project(id: number | null) {
		if (id === null) return null;
		const p = this.s.repos.projects.get(id);
		return p ? { slug: p.slug, name: p.name } : null;
	}

	summary(job: JobRow): JobSummary {
		const steps = this.s.repos.jobs.steps(job.id);
		const current = steps.find((st) => ['running', 'awaiting_input', 'failed'].includes(st.status));
		return {
			id: job.id,
			type: job.type,
			label: jobLabel(job.type),
			status: job.status,
			dryRun: job.dryRun,
			error: job.error,
			createdAt: job.createdAt,
			startedAt: job.startedAt,
			finishedAt: job.finishedAt,
			project: this.#project(job.projectId),
			currentStep: current ? stepLabel(current.key) : null
		};
	}

	list(opts: { projectId?: number; limit?: number } = {}): JobSummary[] {
		return this.s.repos.jobs.list(opts).map((j) => this.summary(j));
	}

	view(id: number): JobView | null {
		const job = this.s.repos.jobs.get(id);
		if (!job) return null;
		const params = parse(job.params);
		return {
			...this.summary(job),
			targetJobId: typeof params.targetJobId === 'number' ? params.targetJobId : null,
			steps: job.steps.map((st) => {
				const state = parse(st.state);
				return {
					id: st.id,
					key: st.key,
					label: stepLabel(st.key),
					status: st.status,
					error: st.error,
					startedAt: st.startedAt,
					finishedAt: st.finishedAt,
					pendingInput: (state.pendingInput as PendingInput | undefined) ?? null,
					manualDns: (state.manual as { fqdn: string; ip: string }[] | undefined) ?? null,
					runId: typeof state.runId === 'number' ? state.runId : null
				};
			}),
			resources: this.s.repos.resources.active({ jobId: id }).map((r) => ({ type: r.type, externalId: r.externalId, meta: parse(r.meta) }))
		};
	}
}

import type { JobRow, LogLevel, ProjectRow } from '$server/infrastructure/db/schema';
import type { ResourceType } from '$lib/domain/safety-policy';
import type { ForgeServices } from '../services';

export interface PendingInput {
	kind: 'workflow' | 'workflow_update' | 'manual_dns';
	title: string;
	payload: Record<string, unknown>;
}

/** Levée par une étape qui a besoin d'une confirmation de l'utilisateur. */
export class AwaitInputSignal extends Error {
	constructor(readonly input: PendingInput) {
		super(input.title);
		this.name = 'AwaitInputSignal';
	}
}

/** Levée quand l'utilisateur interrompt un job en cours. */
export class JobInterrupted extends Error {
	constructor() {
		super('Job interrompu par l’utilisateur');
		this.name = 'JobInterrupted';
	}
}

export interface JobParams {
	confirmations?: Record<string, boolean>;
	[key: string]: unknown;
}

export interface StepContext {
	readonly services: ForgeServices;
	readonly job: JobRow;
	readonly params: JobParams;
	readonly stepKey: string;
	readonly dryRun: boolean;
	readonly signal: AbortSignal;
	/** Projet frais (relu en base à chaque accès). */
	project(): ProjectRow;
	updateProject(patch: Partial<ProjectRow>): ProjectRow;
	/** État persistant de l'étape (reprise idempotente). */
	state: Record<string, unknown>;
	save(): void;
	log(level: LogLevel, message: string): void;
	confirmed(key: string): boolean;
	awaitInput(input: PendingInput): never;
	sleep(ms: number): Promise<void>;
	/** Enregistre une ressource créée par Forge (ignoré en DRY_RUN). */
	recordResource(type: ResourceType, externalId: string | number, meta?: Record<string, unknown>): void;
	/** Résultats des autres étapes du même job. */
	stepState(key: string): Record<string, unknown>;
}

export interface StepDefinition {
	key: string;
	label: string;
	run(ctx: StepContext): Promise<void>;
}

export interface JobDefinition {
	type: string;
	label: string;
	steps(params: JobParams): string[];
	onStart?(ctx: Omit<StepContext, 'stepKey' | 'state' | 'save'>): void;
	onSuccess?(ctx: Omit<StepContext, 'stepKey' | 'state' | 'save'>): void;
	onFailure?(ctx: Omit<StepContext, 'stepKey' | 'state' | 'save'>, error: Error): void;
}

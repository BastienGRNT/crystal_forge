/**
 * Moteur de jobs en processus : une file persistée en base, un seul job à la fois.
 * Chaque étape est idempotente et conserve son état (job_steps.state) : un job en
 * échec peut être repris à l'étape qui a échoué, ou annulé (rollback des ressources
 * créées par CE job uniquement).
 */
import { errorMessage, UserFacingError } from '$lib/domain/errors';
import type { JobRow, LogLevel } from '$server/infrastructure/db/schema';
import type { JobWithSteps } from '$server/infrastructure/db/repositories';
import { executionScope } from '../guard';
import type { ForgeServices } from '../services';
import { JOB_DEFINITIONS, STEPS } from './definitions';
import { AwaitInputSignal, JobInterrupted, type JobParams, type StepContext } from './types';

const parse = <T>(s: string, fallback: T): T => {
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
};

export class JobEngine {
	#running = false;
	#wake: (() => void) | null = null;
	#current: { jobId: number; abort: AbortController } | null = null;
	/** Raison de refuser tout nouveau job (mise à jour de Forge en cours), ou null. */
	#blocker: () => string | null = () => null;

	constructor(private readonly s: ForgeServices) {}

	/** Au démarrage : un job resté « en cours » a été interrompu par un redémarrage. */
	start(): void {
		if (this.#running) return;
		this.#running = true;
		for (const job of this.s.repos.jobs.byStatus(['running', 'rolling_back'])) {
			for (const step of this.s.repos.jobs.steps(job.id)) {
				if (step.status === 'running') this.s.repos.jobs.setStep(step.id, 'failed', { error: 'Interrompu par un redémarrage de Forge' });
			}
			this.s.repos.jobs.setStatus(job.id, 'failed', { error: 'Interrompu par un redémarrage de Forge — vous pouvez reprendre.' });
			this.s.repos.jobs.addLog(job.id, null, 'warn', 'Forge a redémarré pendant ce job : il est marqué en échec, « Reprendre » le relance là où il en était.');
		}
		void this.#loop();
	}

	/** Arrête la boucle (rechargement à chaud en dev). */
	stop(): void {
		this.#running = false;
		this.#current?.abort.abort();
		this.#kick();
	}

	/** Bloque les nouveaux jobs tant que `reason()` renvoie un message (ex. reconstruction de Forge). */
	setBlocker(reason: () => string | null): void {
		this.#blocker = reason;
	}

	enqueue(input: { type: string; projectId: number | null; params?: JobParams; dryRun?: boolean }): JobWithSteps {
		const blocked = this.#blocker();
		if (blocked) throw new UserFacingError(blocked);
		const def = JOB_DEFINITIONS[input.type];
		if (!def) throw new Error(`Type de job inconnu : ${input.type}`);
		const params = input.params ?? {};
		const job = this.s.repos.jobs.create({
			projectId: input.projectId,
			type: input.type,
			dryRun: input.dryRun ?? this.s.guard.isDryRun(),
			params,
			steps: def.steps(params)
		});
		this.s.repos.jobs.addLog(job.id, null, 'info', `Job « ${def.label} » créé${job.dryRun ? ' en mode DRY-RUN (aucune écriture réelle)' : ''}.`);
		this.#emitStatus(job.id);
		this.#kick();
		return job;
	}

	/** Reprend un job en échec (ou interrompu) à partir de l'étape en échec. */
	resume(jobId: number): void {
		const blocked = this.#blocker();
		if (blocked) throw new UserFacingError(blocked);
		const job = this.#mustGet(jobId);
		if (job.status !== 'failed') throw new Error('Seul un job en échec peut être repris.');
		for (const step of job.steps) {
			if (step.status === 'failed' || step.status === 'running') this.s.repos.jobs.setStep(step.id, 'pending', { error: null });
		}
		this.s.repos.jobs.setStatus(jobId, 'queued', { error: null });
		this.s.repos.jobs.addLog(jobId, null, 'info', 'Reprise demandée.');
		this.#emitStatus(jobId);
		this.#kick();
	}

	/** Confirme une demande d'une étape (ex. commit du workflow) et relance le job. */
	confirm(jobId: number, key: string): void {
		const job = this.#mustGet(jobId);
		if (job.status !== 'awaiting_input') throw new Error("Ce job n'attend pas de confirmation.");
		const params = parse<JobParams>(job.params, {});
		params.confirmations = { ...(params.confirmations ?? {}), [key]: true };
		this.s.repos.jobs.updateParams(jobId, params);
		for (const step of job.steps) if (step.status === 'awaiting_input') this.s.repos.jobs.setStep(step.id, 'pending');
		this.s.repos.jobs.setStatus(jobId, 'queued');
		this.s.repos.jobs.addLog(jobId, null, 'info', `Confirmation reçue (${key}).`);
		this.#emitStatus(jobId);
		this.#kick();
	}

	/** Interrompt le job en cours au prochain point d'attente. */
	interrupt(jobId: number): void {
		if (this.#current?.jobId === jobId) this.#current.abort.abort();
		else {
			const job = this.#mustGet(jobId);
			if (job.status === 'queued') {
				this.s.repos.jobs.setStatus(jobId, 'cancelled', { error: 'Annulé avant démarrage' });
				this.#emitStatus(jobId);
			}
		}
	}

	/** Annule un job en échec / en attente : marque « annulé » puis lance le rollback de SES ressources. */
	cancelWithRollback(jobId: number): JobWithSteps {
		const job = this.#mustGet(jobId);
		if (!['failed', 'awaiting_input'].includes(job.status)) throw new Error('Seul un job en échec ou en attente peut être annulé.');
		this.s.repos.jobs.setStatus(jobId, 'cancelled', { error: job.error ?? 'Annulé par l’utilisateur' });
		this.s.repos.jobs.addLog(jobId, null, 'warn', 'Job annulé : rollback des ressources créées par ce job.');
		this.#emitStatus(jobId);
		return this.enqueue({ type: 'rollback', projectId: job.projectId, params: { targetJobId: jobId }, dryRun: job.dryRun });
	}

	isBusy(): boolean {
		return this.#current !== null;
	}

	#mustGet(jobId: number): JobWithSteps {
		const job = this.s.repos.jobs.get(jobId);
		if (!job) throw new Error(`Job ${jobId} introuvable`);
		return job;
	}

	#kick() {
		this.#wake?.();
	}

	#emitStatus(jobId: number) {
		this.s.events.emitJob(jobId, { kind: 'status', jobId });
	}

	#log(jobId: number, stepKey: string | null, level: LogLevel, message: string) {
		const log = this.s.repos.jobs.addLog(jobId, stepKey, level, this.s.redactor.redact(message));
		this.s.events.emitJob(jobId, { kind: 'log', log });
	}

	async #loop() {
		while (this.#running) {
			const next = this.s.repos.jobs.nextQueued();
			if (!next) {
				await new Promise<void>((resolve) => {
					const t = setTimeout(resolve, 2000);
					this.#wake = () => {
						clearTimeout(t);
						resolve();
					};
				});
				this.#wake = null;
				continue;
			}
			try {
				await this.#execute(next);
			} catch (err) {
				// Ne doit jamais arriver : les erreurs d'étape sont gérées dans #execute.
				console.error('[forge] erreur inattendue du moteur de jobs', err);
				this.s.repos.jobs.setStatus(next.id, 'failed', { error: errorMessage(err) });
				this.#emitStatus(next.id);
			} finally {
				// Sinon isBusy() resterait vrai (mise à jour de Forge et reset du mock bloqués).
				this.#current = null;
			}
		}
	}

	async #execute(row: JobRow) {
		const def = JOB_DEFINITIONS[row.type];
		if (!def) {
			this.s.repos.jobs.setStatus(row.id, 'failed', { error: `Type inconnu : ${row.type}` });
			return;
		}
		const abort = new AbortController();
		this.#current = { jobId: row.id, abort };
		const isRollback = row.type === 'rollback';
		this.s.repos.jobs.setStatus(row.id, isRollback ? 'rolling_back' : 'running');
		this.#emitStatus(row.id);

		const params = parse<JobParams>(row.params, {});
		const projectId = row.projectId;
		const base = {
			services: this.s,
			job: row,
			params,
			dryRun: row.dryRun,
			signal: abort.signal,
			project: () => {
				if (projectId === null) throw new Error('Job sans projet');
				const p = this.s.repos.projects.get(projectId);
				if (!p) throw new Error(`Projet ${projectId} introuvable`);
				return p;
			},
			updateProject: (patch: Parameters<StepContext['updateProject']>[0]) => {
				if (projectId === null) throw new Error('Job sans projet');
				return this.s.repos.projects.update(projectId, patch);
			},
			log: (level: LogLevel, message: string) => this.#log(row.id, null, level, message),
			confirmed: (key: string) => params.confirmations?.[key] === true,
			awaitInput: (input: ConstructorParameters<typeof AwaitInputSignal>[0]): never => {
				throw new AwaitInputSignal(input);
			},
			sleep: (ms: number) =>
				new Promise<void>((resolve, reject) => {
					if (abort.signal.aborted) return reject(new JobInterrupted());
					const t = setTimeout(resolve, ms);
					abort.signal.addEventListener(
						'abort',
						() => {
							clearTimeout(t);
							reject(new JobInterrupted());
						},
						{ once: true }
					);
				}),
			recordResource: () => {},
			stepState: (key: string) => {
				const st = this.s.repos.jobs.steps(row.id).find((x) => x.key === key);
				return st ? parse<Record<string, unknown>>(st.state, {}) : {};
			}
		};

		def.onStart?.(base);

		const steps = this.s.repos.jobs.steps(row.id);
		for (const step of steps) {
			if (step.status === 'succeeded' || step.status === 'skipped') continue;
			const sd = STEPS[step.key];
			if (!sd) {
				// Le job s'arrête : les étapes suivantes peuvent dépendre de celle-ci.
				const error = `Étape inconnue : ${step.key}`;
				this.s.repos.jobs.setStep(step.id, 'failed', { error });
				this.s.repos.jobs.setStatus(row.id, 'failed', { error });
				this.#log(row.id, step.key, 'error', `✖ ${error}`);
				this.#emitStatus(row.id);
				return;
			}
			const state = parse<Record<string, unknown>>(step.state, {});
			delete state.pendingInput;
			const ctx: StepContext = {
				...base,
				stepKey: step.key,
				state,
				save: () => this.s.repos.jobs.saveStepState(step.id, state),
				log: (level, message) => this.#log(row.id, step.key, level, message),
				recordResource: (type, externalId, meta) => {
					if (row.dryRun) {
						this.#log(row.id, step.key, 'dry', `[DRY-RUN] Ressource ${type} « ${externalId} » non enregistrée.`);
						return;
					}
					this.s.repos.resources.record({ type, externalId, projectId, jobId: row.id, meta });
				}
			};

			this.s.repos.jobs.setStep(step.id, 'running', { error: null, state });
			this.#emitStatus(row.id);
			this.#log(row.id, step.key, 'info', `▶ ${sd.label}`);
			const t0 = Date.now();
			try {
				await executionScope.run({ jobId: row.id, stepKey: step.key, dryRun: row.dryRun, log: ctx.log }, () => sd.run(ctx));
				this.s.repos.jobs.setStep(step.id, 'succeeded', { state });
				this.#log(row.id, step.key, 'success', `✔ ${sd.label} — terminé en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
				this.#emitStatus(row.id);
			} catch (err) {
				if (err instanceof AwaitInputSignal) {
					state.pendingInput = err.input;
					this.s.repos.jobs.setStep(step.id, 'awaiting_input', { state });
					this.s.repos.jobs.setStatus(row.id, 'awaiting_input');
					this.#log(row.id, step.key, 'warn', `⏸ ${err.input.title}`);
					this.#emitStatus(row.id);
					return;
				}
				const msg = err instanceof JobInterrupted ? 'Interrompu par l’utilisateur' : errorMessage(err);
				this.s.repos.jobs.setStep(step.id, 'failed', { error: this.s.redactor.redact(msg), state });
				this.s.repos.jobs.setStatus(row.id, 'failed', { error: this.s.redactor.redact(msg) });
				this.#log(row.id, step.key, 'error', `✖ ${sd.label} : ${msg}`);
				if (!isRollback) {
					try {
						def.onFailure?.(base, err as Error);
					} catch {
						/* le projet a pu être supprimé */
					}
				}
				this.#emitStatus(row.id);
				return;
			}
		}

		this.s.repos.jobs.setStatus(row.id, isRollback ? 'rolled_back' : 'succeeded');
		try {
			def.onSuccess?.(base);
		} catch {
			/* projet supprimé par le job lui-même */
		}
		this.#log(row.id, null, 'success', isRollback ? 'Rollback terminé.' : 'Job terminé avec succès.');
		this.#emitStatus(row.id);
	}
}

import { EventEmitter } from 'node:events';
import type { JobLogRow } from '$server/infrastructure/db/schema';

export type JobEvent = { kind: 'log'; log: JobLogRow } | { kind: 'status'; jobId: number };

/** Bus d'événements en mémoire : alimente le SSE des pages de job. */
export class EventBus {
	readonly #emitter = new EventEmitter();

	constructor() {
		this.#emitter.setMaxListeners(200);
	}

	emitJob(jobId: number, event: JobEvent) {
		this.#emitter.emit(`job:${jobId}`, event);
		if (event.kind === 'status') this.#emitter.emit('jobs', jobId);
	}

	onJob(jobId: number, fn: (e: JobEvent) => void): () => void {
		this.#emitter.on(`job:${jobId}`, fn);
		return () => this.#emitter.off(`job:${jobId}`, fn);
	}

	onAnyJobStatus(fn: (jobId: number) => void): () => void {
		this.#emitter.on('jobs', fn);
		return () => this.#emitter.off('jobs', fn);
	}
}

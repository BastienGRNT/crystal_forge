import type { ForgeServices } from '../services';
import type { NotificationRow } from '$server/infrastructure/db/schema';
import { jobLabel } from '../jobs/definitions';

const KEEP_MS = 30 * 86_400_000;
/** Jobs de fond trop fréquents pour mériter une notification quand ils réussissent. */
const QUIET_ON_SUCCESS = new Set(['prune_cache', 'sleep', 'wake']);

export type NotificationInput = Omit<NotificationRow, 'id' | 'ts'>;

/** Centre de notifications : historique (30 jours) des événements marquants, visible selon les droits. */
export class NotificationService {
	#lastPrune = 0;
	/** Dernier statut notifié par job : l'événement « status » est aussi émis à chaque étape. */
	readonly #seen = new Map<number, string>();

	constructor(private readonly s: ForgeServices) {}

	add(n: NotificationInput): void {
		this.s.repos.notifications.add(n);
		const now = Date.now();
		if (now - this.#lastPrune > 3600_000) {
			this.#lastPrune = now;
			this.s.repos.notifications.prune(now - KEEP_MS);
		}
	}

	/** Branche la source « jobs » : chaque job terminé (ou en attente de réponse) laisse une trace. */
	listenToJobs(): void {
		this.s.events.onAnyJobStatus((jobId) => {
			const job = this.s.repos.jobs.get(jobId);
			if (!job || this.#seen.get(jobId) === job.status) return;
			this.#seen.set(jobId, job.status);
			if (this.#seen.size > 500) this.#seen.delete(this.#seen.keys().next().value!);
			const p = job.projectId ? this.s.repos.projects.get(job.projectId) : undefined;
			const label = jobLabel(job.type);
			const where = p ? ` · ${p.name}` : '';
			const href = `/jobs/${job.id}`;
			const base = { kind: 'job' as const, projectId: job.projectId, href };
			switch (job.status) {
				case 'succeeded':
					if (!QUIET_ON_SUCCESS.has(job.type)) this.add({ ...base, level: 'success', title: `${label} réussi${where}`, body: job.dryRun ? 'Simulation (DRY_RUN)' : null });
					break;
				case 'failed':
					this.add({ ...base, level: 'error', title: `${label} en échec${where}`, body: job.error });
					break;
				case 'rolled_back':
					this.add({ ...base, level: 'warn', title: `${label} annulé et défait${where}`, body: job.error });
					break;
				case 'awaiting_input':
					this.add({ ...base, level: 'warn', title: `${label} attend votre confirmation${where}`, body: null });
					break;
			}
		});
	}

	/** projectIds null : admin (tout, y compris les événements sans projet). */
	list(projectIds: number[] | null, limit = 40) {
		return this.s.repos.notifications.recent(projectIds, limit);
	}
}

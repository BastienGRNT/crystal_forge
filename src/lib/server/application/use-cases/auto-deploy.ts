/**
 * Déploiement automatique (remplace le webhook et le runner) : toutes les minutes, Forge lit
 * le dernier commit de la branche de chaque projet déployé par le CT de build ; s'il a changé,
 * un redéploiement est lancé. Un commit dont le déploiement a échoué n'est pas relancé en
 * boucle : on attend le commit suivant (ou un « Redéployer » manuel).
 * Le même passage éteint le CT de build resté inutilisé.
 */
import { errorMessage } from '$lib/domain/errors';
import { idleShutdownBuilder } from '../builder';
import type { JobEngine } from '../jobs/engine';
import type { ForgeServices } from '../services';

export class AutoDeployService {
	static readonly CHECK_EVERY_MS = 60_000;
	/** Dernier commit pour lequel un redéploiement a été lancé, par projet. */
	readonly #launched = new Map<number, string>();
	#ticking = false;

	constructor(
		private readonly s: ForgeServices,
		private readonly engine: JobEngine
	) {}

	async tick(): Promise<void> {
		if (this.#ticking) return;
		this.#ticking = true;
		try {
			for (const p of this.s.repos.projects.list()) {
				if (p.status !== 'active' || p.buildMode !== 'builder' || !p.autoDeploy || !p.ctid) continue;
				if (this.s.repos.jobs.activeForProject(p.id)) continue;
				try {
					const head = await this.s.github.api.latestCommit(p.repoOwner, p.repoName, p.branch);
					if (!p.deployedSha) {
						// Premier passage : le commit en ligne est celui du dernier déploiement.
						this.s.repos.projects.update(p.id, { deployedSha: head.sha });
						continue;
					}
					if (head.sha === p.deployedSha || this.#launched.get(p.id) === head.sha) continue;
					this.#launched.set(p.id, head.sha);
					const job = this.engine.enqueue({ type: 'redeploy', projectId: p.id, params: { sha: head.sha, auto: true } });
					console.info(`[auto-deploy] ${p.slug} : nouveau commit ${head.sha.slice(0, 7)} — job #${job.id}.`);
				} catch (err) {
					console.warn(`[auto-deploy] ${p.slug} : ${errorMessage(err)}`);
				}
			}
			await idleShutdownBuilder(this.s);
		} finally {
			this.#ticking = false;
		}
	}
}

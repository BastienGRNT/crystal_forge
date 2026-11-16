/**
 * Mise en veille des serveurs de dev.
 *   • Toutes les 2 min, Forge lit (par SSH, en lecture) un compteur iptables qui ne fait que
 *     compter les nouvelles connexions vers le port de l'app.
 *   • Sans nouvelle connexion pendant N minutes : NPM est basculé vers la page de réveil de
 *     Forge, puis le CT est éteint proprement.
 *   • Premier visiteur : la page de réveil s'affiche, Forge rallume le CT, attend que l'app
 *     réponde, puis remet NPM vers le CT. La page se recharge seule.
 * Toutes les écritures passent par le garde (DRY_RUN : rien n'est éteint).
 */
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { errorMessage } from '$lib/domain/errors';
import { hostMemoryInUse } from '$lib/domain/sizes';
import { idleRuleCommand, isIdle, nextActivity, parseIdleCounter, WAKE_PORT } from '$lib/domain/sleep';
import type { ProjectRow } from '$server/infrastructure/db/schema';
import type { ForgeServices } from '../services';

const CHECK_EVERY_MS = 2 * 60_000;
/** RAM que l'hôte doit garder libre après un réveil (sinon on refuse, plutôt que de faire swapper tout le monde). */
const WAKE_RAM_MARGIN = 2 * 1024 ** 3;

const tcpOpen = (host: string, port: number) =>
	new Promise<boolean>((resolve) => {
		const s = connect({ host, port, timeout: 3000 });
		const done = (ok: boolean) => {
			s.destroy();
			resolve(ok);
		};
		s.once('connect', () => done(true));
		s.once('timeout', () => done(false));
		s.once('error', () => done(false));
	});

export class SleepService {
	readonly #activity = new Map<number, { count: number; at: number }>();
	readonly #waking = new Map<number, Promise<void>>();
	readonly #wakeError = new Map<number, { at: number; error: string }>();
	#ticking = false;

	constructor(private readonly s: ForgeServices) {}

	static readonly CHECK_EVERY_MS = CHECK_EVERY_MS;

	/** IP de Forge vue par NPM (réseau des CT). Réglage `sleep.wakeHost` sinon détection. */
	wakeHost(): string | null {
		const set = this.s.settings.get('sleep.wakeHost').trim();
		if (set) return set;
		const start = this.s.settings.safetyContext().ipRange.start.split('.').slice(0, 3).join('.');
		for (const list of Object.values(networkInterfaces())) {
			for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && a.address.startsWith(`${start}.`)) return a.address;
		}
		return null;
	}

	/** État affiché sur la page Conteneur. */
	status(p: ProjectRow): { sleeping: boolean; since: number | null; lastActivity: number | null; wakeError: string | null } {
		return {
			sleeping: !!p.sleepingSince,
			since: p.sleepingSince ?? null,
			lastActivity: this.#activity.get(p.id)?.at ?? null,
			wakeError: this.#wakeError.get(p.id)?.error ?? null
		};
	}

	#eligible(p: ProjectRow): boolean {
		return p.environment === 'development' && !!p.sleepAfterMin && p.sleepAfterMin > 0 && p.status === 'active' && !!p.ctid && !!p.ip && !p.sleepingSince;
	}

	async tick(): Promise<void> {
		if (this.#ticking) return;
		this.#ticking = true;
		try {
			const guests = await this.s.proxmox.guests().catch(() => []);
			for (const p of this.s.repos.projects.list()) {
				if (!this.#eligible(p)) {
					if (!p.sleepingSince) this.#activity.delete(p.id);
					continue;
				}
				if (guests.find((g) => g.vmid === p.ctid)?.status !== 'running') continue;
				if (this.s.repos.jobs.activeForProject(p.id)) {
					this.#activity.set(p.id, { count: this.#activity.get(p.id)?.count ?? -1, at: Date.now() });
					continue;
				}
				try {
					await this.#check(p);
				} catch (err) {
					console.warn(`[veille] ${p.slug} : ${errorMessage(err)}`);
				}
			}
		} finally {
			this.#ticking = false;
		}
	}

	async #check(p: ProjectRow) {
		const t = { ip: p.ip!, sshHostKey: p.sshHostKey };
		let count = parseIdleCounter((await this.s.shell.idleCounter(t)).stdout, p.appPort);
		if (count === null) {
			// Première fois (ou CT redémarré) : pose la règle de comptage, qui ne filtre rien.
			await this.s.shell.run(t, 'root', idleRuleCommand(p.appPort), { summary: `Compteur de visites sur le port ${p.appPort} (mise en veille)` });
			count = parseIdleCounter((await this.s.shell.idleCounter(t)).stdout, p.appPort);
			if (count === null) return; // DRY_RUN : règle simulée, on ne décide rien.
		}
		const now = Date.now();
		const a = nextActivity(this.#activity.get(p.id), count, now);
		this.#activity.set(p.id, a);
		if (isIdle(a, p.sleepAfterMin, now)) await this.sleep(p);
	}

	#targets(p: ProjectRow) {
		const wakeHost = this.wakeHost();
		if (!wakeHost) throw new Error('adresse de Forge sur le réseau des CT introuvable (réglage sleep.wakeHost)');
		return { projectIp: p.ip!, appPort: p.appPort, wakeHost };
	}

	async #pointHosts(p: ProjectRow, to: 'wake' | 'app') {
		const t = this.#targets(p);
		const target = to === 'wake' ? { forwardHost: t.wakeHost, forwardPort: WAKE_PORT } : { forwardHost: t.projectIp, forwardPort: t.appPort };
		const owned = this.s.repos.resources.active({ projectId: p.id }).filter((r) => r.type === 'npm_proxy_host');
		const hosts = await this.s.proxy.api.listProxyHosts();
		for (const r of owned) {
			const h = hosts.find((x) => String(x.id) === r.externalId);
			if (!h || (h.forwardHost === target.forwardHost && h.forwardPort === target.forwardPort)) continue;
			await this.s.proxy.toggleSleepTarget(h.id, target, t);
		}
	}

	/** Endort le serveur : NPM d'abord (personne ne tombe sur une erreur), puis arrêt propre du CT. */
	async sleep(p: ProjectRow): Promise<void> {
		if (this.s.guard.isDryRun()) {
			console.info(`[veille] ${p.slug} : inactif depuis ${p.sleepAfterMin} min — DRY_RUN, rien n'est éteint.`);
			this.#activity.set(p.id, { count: this.#activity.get(p.id)?.count ?? -1, at: Date.now() });
			return;
		}
		await this.#pointHosts(p, 'wake');
		this.s.repos.projects.update(p.id, { sleepingSince: Date.now() });
		await this.s.proxmox.waitTask(await this.s.proxmox.power(p.ctid!, 'shutdown'), { timeoutMs: 3 * 60_000 });
		this.#activity.delete(p.id);
		console.info(`[veille] ${p.slug} endormi.`);
	}

	/** Réveille le serveur (appels simultanés regroupés). */
	wake(projectId: number): Promise<void> {
		const running = this.#waking.get(projectId);
		if (running) return running;
		const job = this.#doWake(projectId).finally(() => this.#waking.delete(projectId));
		this.#waking.set(projectId, job);
		return job;
	}

	/** Réveil demandé par un visiteur : relancé au plus toutes les 30 s après un échec. */
	wakeFromVisit(projectId: number): void {
		const err = this.#wakeError.get(projectId);
		if (err && Date.now() - err.at < 30_000) return;
		void this.wake(projectId).catch(() => {});
	}

	wakeErrorFor(projectId: number): string | null {
		return this.#wakeError.get(projectId)?.error ?? null;
	}

	async #doWake(projectId: number) {
		const p = this.s.repos.projects.get(projectId);
		if (!p?.sleepingSince || !p.ctid || !p.ip) return;
		try {
			const g = (await this.s.proxmox.guests()).find((x) => x.vmid === p.ctid);
			if (g?.status !== 'running') {
				// Contrôle d'admission : on ne rallume pas un CT si l'hôte n'a plus la place.
				const n = await this.s.proxmox.nodeStatus();
				const need = g?.maxmem ?? 0;
				if (hostMemoryInUse(n.memory) + need > n.memory.total - WAKE_RAM_MARGIN) {
					throw new Error(`RAM du serveur insuffisante pour le réveiller (${Math.round(need / 1024 ** 2)} Mo demandés) — réessayez plus tard ou endormez un autre serveur`);
				}
			}
			if (g?.status !== 'running') await this.s.proxmox.waitTask(await this.s.proxmox.power(p.ctid, 'start'), { timeoutMs: 3 * 60_000 });
			const deadline = Date.now() + 4 * 60_000;
			while (!(await tcpOpen(p.ip, p.appPort))) {
				if (Date.now() > deadline) throw new Error(`l'app ne répond pas sur le port ${p.appPort}`);
				await new Promise((r) => setTimeout(r, 2000));
			}
			await this.#pointHosts(p, 'app');
			this.s.repos.projects.update(p.id, { sleepingSince: null });
			this.#activity.set(p.id, { count: -1, at: Date.now() });
			this.#wakeError.delete(p.id);
			console.info(`[veille] ${p.slug} réveillé.`);
		} catch (err) {
			this.#wakeError.set(p.id, { at: Date.now(), error: errorMessage(err) });
			throw err;
		}
	}

	/** Un job sur un projet endormi (redéploiement, base…) le réveille d'abord. */
	async beforeJob(projectId: number | null): Promise<void> {
		if (projectId === null) return;
		if (this.s.repos.projects.get(projectId)?.sleepingSince) await this.wake(projectId);
	}

	/** Réglage du délai (serveurs de dev uniquement). */
	setDelay(p: ProjectRow, minutes: number): void {
		this.s.repos.projects.update(p.id, { sleepAfterMin: p.environment === 'development' && minutes > 0 ? Math.min(Math.trunc(minutes), 24 * 60) : null });
		this.#activity.delete(p.id);
	}
}

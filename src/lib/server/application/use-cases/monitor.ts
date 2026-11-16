import type { ForgeServices } from '../services';
import type { NotificationService } from './notifications';

const DAY = 86_400_000;
export const UPTIME_RETENTION_MS = 7 * DAY;
/** Deux échecs d'affilée avant de déclarer un site « en panne » (évite les faux positifs). */
const DOWN_AFTER = 2;

export interface UptimeBucket {
	from: number;
	/** Part des relevés OK (null : aucun relevé). */
	ratio: number | null;
	avgMs: number | null;
}
export interface UptimeIncident {
	from: number;
	to: number | null;
	error: string;
}
export interface DomainUptime {
	domainId: number;
	fqdn: string;
	up: boolean | null;
	lastCheck: number | null;
	lastMs: number | null;
	lastStatus: number | null;
	uptime24h: number | null;
	uptime7d: number | null;
	avgMs24h: number | null;
	buckets: UptimeBucket[];
	incidents: UptimeIncident[];
}

/**
 * Surveillance des sites : chaque minute, une requête HTTPS sur chaque domaine actif.
 * Lecture seule : aucune écriture hors de la base de Forge. Les projets en veille sont ignorés
 * (une visite les réveillerait).
 */
export class MonitorService {
	static readonly CHECK_EVERY_MS = 60_000;
	readonly #streak = new Map<number, { down: number; alerted: boolean }>();
	#running = false;
	#lastPrune = 0;

	constructor(
		private readonly s: ForgeServices,
		private readonly notify: NotificationService
	) {}

	#targets() {
		const live = new Map(
			this.s.repos.projects
				.list()
				.filter((p) => p.status === 'active' && !p.sleepingSince)
				.map((p) => [p.id, p])
		);
		return this.s.repos.domains
			.all()
			.filter((d) => d.status === 'active' && live.has(d.projectId))
			.map((d) => ({ d, p: live.get(d.projectId)! }));
	}

	async tick(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		try {
			const now = Date.now();
			await Promise.all(
				this.#targets().map(async ({ d, p }) => {
					const r = await this.s
						.probe()
						.http(`https://${d.fqdn}/`, 10_000)
						.catch((err) => ({ ok: false, status: null, error: err instanceof Error ? err.message : String(err), ms: 0 }));
					const error = r.ok ? null : (r.error ?? (r.status ? `HTTP ${r.status}` : 'injoignable'));
					this.s.repos.uptime.add({ domainId: d.id, ts: now, ok: r.ok, status: r.status, ms: r.ok ? Math.round(r.ms) : null, error });
					const st = this.#streak.get(d.id) ?? { down: 0, alerted: false };
					if (r.ok) {
						if (st.alerted) this.notify.add({ kind: 'uptime', level: 'success', projectId: p.id, title: `${d.fqdn} répond de nouveau`, body: `Temps de réponse : ${Math.round(r.ms)} ms`, href: `/projects/${p.slug}/domains` });
						this.#streak.set(d.id, { down: 0, alerted: false });
					} else {
						st.down += 1;
						if (st.down >= DOWN_AFTER && !st.alerted) {
							st.alerted = true;
							this.notify.add({ kind: 'uptime', level: 'error', projectId: p.id, title: `${d.fqdn} ne répond plus`, body: error, href: `/projects/${p.slug}/domains` });
						}
						this.#streak.set(d.id, st);
					}
				})
			);
			if (now - this.#lastPrune > 3600_000) {
				this.#lastPrune = now;
				this.s.repos.uptime.prune(now - UPTIME_RETENTION_MS);
			}
		} finally {
			this.#running = false;
		}
	}

	/** État de surveillance des domaines d'un projet (ou de tous si projectId absent). */
	forDomains(domains: { id: number; fqdn: string }[], range: '24h' | '7d' = '24h'): DomainUptime[] {
		const now = Date.now();
		const rows = this.s.repos.uptime.since(
			domains.map((d) => d.id),
			now - 7 * DAY
		);
		const span = range === '24h' ? DAY : 7 * DAY;
		const n = range === '24h' ? 48 : 56;
		const step = span / n;
		const start = now - span;
		return domains.map((d) => {
			const mine = rows.filter((r) => r.domainId === d.id);
			const day = mine.filter((r) => r.ts > now - DAY);
			const last = mine.at(-1);
			const ratio = (xs: typeof mine) => (xs.length ? xs.filter((x) => x.ok).length / xs.length : null);
			const avg = (xs: typeof mine) => {
				const v = xs.filter((x) => x.ok && x.ms != null).map((x) => x.ms!);
				return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
			};
			const buckets: UptimeBucket[] = Array.from({ length: n }, (_, i) => {
				const from = start + i * step;
				const xs = mine.filter((r) => r.ts > from && r.ts <= from + step);
				return { from, ratio: ratio(xs), avgMs: avg(xs) };
			});
			const incidents: UptimeIncident[] = [];
			let cur: UptimeIncident | null = null;
			for (const r of mine) {
				if (!r.ok && !cur) cur = { from: r.ts, to: null, error: r.error ?? 'injoignable' };
				else if (r.ok && cur) {
					cur.to = r.ts;
					incidents.push(cur);
					cur = null;
				}
			}
			if (cur) incidents.push(cur);
			return {
				domainId: d.id,
				fqdn: d.fqdn,
				up: last ? last.ok : null,
				lastCheck: last?.ts ?? null,
				lastMs: last?.ms ?? null,
				lastStatus: last?.status ?? null,
				uptime24h: ratio(day),
				uptime7d: ratio(mine),
				avgMs24h: avg(day),
				buckets,
				incidents: incidents.reverse().slice(0, 20)
			};
		});
	}

	/** Mode démo : 7 jours d'historique plausible pour que les graphiques aient du contenu. */
	seedDemoHistory(): void {
		const now = Date.now();
		for (const { d } of this.#targets()) {
			if (this.s.repos.uptime.last(d.id)) continue;
			const base = 80 + (d.id % 5) * 40;
			for (let t = now - 7 * DAY; t < now; t += 10 * 60_000) {
				const hour = new Date(t).getHours();
				const outage = d.id % 3 === 0 && t > now - 2 * DAY && t < now - 2 * DAY + 25 * 60_000;
				const ms = Math.round(base * (1 + (hour >= 9 && hour <= 21 ? 0.4 : 0)) * (0.8 + Math.random() * 0.5));
				this.s.repos.uptime.add({ domainId: d.id, ts: t, ok: !outage, status: outage ? 502 : 200, ms: outage ? null : ms, error: outage ? 'HTTP 502' : null });
			}
		}
	}
}

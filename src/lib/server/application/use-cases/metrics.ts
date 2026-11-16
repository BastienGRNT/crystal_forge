import type { PveRrdPoint, RrdTimeframe } from '../ports';

export type MetricsRange = '1h' | '24h' | '7d';
export const RANGE_TIMEFRAME: Record<MetricsRange, RrdTimeframe> = { '1h': 'hour', '24h': 'day', '7d': 'week' };

export function parseRange(v: string | null): MetricsRange {
	return v === '24h' || v === '7d' ? v : '1h';
}

/** Séries prêtes à tracer : CPU en ratio de la machine, RAM en octets, réseau en octets/s. */
export interface MetricsSeries {
	range: MetricsRange;
	points: { t: number; cpu: number | null; mem: number | null; netin: number | null; netout: number | null }[];
	maxmem: number | null;
	maxcpu: number | null;
}

export function toSeries(range: MetricsRange, rows: PveRrdPoint[], now = Date.now() / 1000): MetricsSeries {
	const horizon = range === '1h' ? 3600 : range === '24h' ? 86_400 : 7 * 86_400;
	const pts = rows.filter((r) => r.time >= now - horizon - 60).sort((a, b) => a.time - b.time);
	const last = [...pts].reverse().find((r) => r.maxmem);
	return {
		range,
		points: pts.map((r) => ({ t: r.time * 1000, cpu: r.cpu, mem: r.mem, netin: r.netin, netout: r.netout })),
		maxmem: last?.maxmem ?? null,
		maxcpu: last?.maxcpu ?? null
	};
}

/** Formatage pour l'UI (français). */

export function bytes(n: number | null | undefined, digits = 1): string {
	if (n === null || n === undefined || !Number.isFinite(n)) return '—';
	const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
	let v = n;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toLocaleString('fr-FR', { maximumFractionDigits: i === 0 ? 0 : digits })} ${units[i]}`;
}

export function percent(ratio: number, digits = 0): string {
	if (!Number.isFinite(ratio)) return '—';
	return `${(ratio * 100).toLocaleString('fr-FR', { maximumFractionDigits: digits })} %`;
}

const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });

export function relativeTime(input: string | number | Date | null | undefined): string {
	if (input === null || input === undefined) return '—';
	const t = typeof input === 'number' ? input : new Date(input).getTime();
	if (!Number.isFinite(t)) return '—';
	const diff = (t - Date.now()) / 1000;
	const abs = Math.abs(diff);
	if (abs < 45) return diff < 0 ? "à l'instant" : 'dans un instant';
	if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
	if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
	if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
	if (abs < 86400 * 365) return rtf.format(Math.round(diff / (86400 * 30)), 'month');
	return rtf.format(Math.round(diff / (86400 * 365)), 'year');
}

export function dateTime(input: string | number | null | undefined): string {
	if (input === null || input === undefined) return '—';
	const d = new Date(input);
	if (Number.isNaN(d.getTime())) return '—';
	return d.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
}

export function time(input: number): string {
	return new Date(input).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function duration(ms: number | null | undefined): string {
	if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s} s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h} h ${String(m % 60).padStart(2, '0')}`;
	return `${Math.floor(h / 24)} j ${h % 24} h`;
}

export function uptime(seconds: number): string {
	if (!seconds) return '—';
	return duration(seconds * 1000);
}

export function daysUntil(input: string | number | null | undefined): number | null {
	if (input === null || input === undefined) return null;
	const t = typeof input === 'number' ? input : Date.parse(String(input).replace(' ', 'T') + (String(input).includes('Z') || String(input).includes('+') ? '' : 'Z'));
	if (!Number.isFinite(t)) return null;
	return Math.round((t - Date.now()) / 86400_000);
}

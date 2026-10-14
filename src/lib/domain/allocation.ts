import { intToIp, ipToInt, isIpv4 } from './network';

export interface CtidRange {
	min: number;
	max: number;
}

export interface IpRange {
	start: string;
	end: string;
}

/** Premier CTID libre de la plage, en excluant tous les IDs connus (CT + VM + réservations). */
export function nextFreeCtid(used: Iterable<number>, range: CtidRange, exclude: Iterable<number> = []): number | null {
	const taken = new Set<number>([...used, ...exclude]);
	for (let id = range.min; id <= range.max; id++) {
		if (!taken.has(id)) return id;
	}
	return null;
}

/**
 * Liste ordonnée des IP candidates de la plage, hors IP déclarées et réservées.
 * Le contrôle actif (ping/ARP) est fait ensuite sur chaque candidate, dans l'ordre.
 */
export function candidateIps(used: Iterable<string>, range: IpRange, reserved: Iterable<string> = []): string[] {
	if (!isIpv4(range.start) || !isIpv4(range.end)) throw new Error('Plage IP invalide');
	const start = ipToInt(range.start);
	const end = ipToInt(range.end);
	if (end < start) throw new Error('Plage IP inversée');
	const taken = new Set<number>();
	for (const ip of [...used, ...reserved]) {
		if (isIpv4(ip)) taken.add(ipToInt(ip));
	}
	const out: string[] = [];
	for (let n = start; n <= end; n++) {
		if (!taken.has(n)) out.push(intToIp(n));
	}
	return out;
}

/** Choisit la première IP candidate qui ne répond pas au contrôle actif. */
export async function pickFreeIp(
	candidates: string[],
	isAlive: (ip: string) => Promise<boolean>
): Promise<{ ip: string | null; skipped: string[] }> {
	const skipped: string[] = [];
	for (const ip of candidates) {
		if (await isAlive(ip)) {
			skipped.push(ip);
			continue;
		}
		return { ip, skipped };
	}
	return { ip: null, skipped };
}

export function isInIpRange(ip: string, range: IpRange): boolean {
	if (!isIpv4(ip)) return false;
	const n = ipToInt(ip);
	return n >= ipToInt(range.start) && n <= ipToInt(range.end);
}

export function isInCtidRange(id: number, range: CtidRange): boolean {
	return Number.isInteger(id) && id >= range.min && id <= range.max;
}

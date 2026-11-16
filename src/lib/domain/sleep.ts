/**
 * Mise en veille des serveurs de dev : arrêtés après N minutes sans visiteur,
 * réveillés par le premier visiteur (NPM l'envoie vers la page d'attente de Forge).
 */
import { SafetyViolation } from './errors';

/** Port de la page « réveil en cours » servie par Forge (joignable depuis NPM uniquement). */
export const WAKE_PORT = 3001;
/** Délai proposé par défaut aux serveurs de dev. */
export const DEFAULT_SLEEP_MINUTES = 30;
export const SLEEP_MINUTES_CHOICES = [0, 15, 30, 60, 120, 240] as const;

const isPort = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;
const isIpv4 = (s: string) => /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(s);

const tag = (port: number) => `forge-idle:${port}`;

/** Règle iptables qui ne fait que COMPTER les nouvelles connexions vers le port de l'app (aucun filtrage). */
export function idleRuleCommand(port: number): string {
	if (!isPort(port)) throw new Error(`Port invalide : ${port}`);
	const rule = `PREROUTING -p tcp --dport ${port} --syn -m comment --comment ${tag(port)}`;
	return `iptables -w -t mangle -C ${rule} 2>/dev/null || iptables -w -t mangle -A ${rule}`;
}

/** Lecture du compteur (lecture seule). */
export const IDLE_READ_COMMAND = 'iptables -w -t mangle -nvxL PREROUTING';

/** Nombre de connexions comptées, ou null si la règle n'est pas (encore) posée. */
export function parseIdleCounter(stdout: string, port: number): number | null {
	const line = stdout.split('\n').find((l) => l.includes(`/* ${tag(port)} */`));
	const n = line ? Number(line.trim().split(/\s+/)[0]) : NaN;
	return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Heure de dernière activité après une lecture du compteur. */
export function nextActivity(prev: { count: number; at: number } | undefined, count: number, now: number): { count: number; at: number } {
	if (!prev || count !== prev.count) return { count, at: now };
	return prev;
}

export function isIdle(activity: { at: number } | undefined, sleepAfterMin: number | null, now: number): boolean {
	if (!activity || !sleepAfterMin || sleepAfterMin <= 0) return false;
	return now - activity.at >= sleepAfterMin * 60_000;
}

/**
 * Bascule d'un proxy host entre le CT du projet et la page de réveil de Forge.
 * Seules ces deux cibles sont permises, et seulement depuis l'une d'elles.
 */
export function assertCanToggleSleep(
	host: { id: number; forwardHost: string; forwardPort: number },
	to: { forwardHost: string; forwardPort: number },
	t: { projectIp: string; appPort: number; wakeHost: string }
): void {
	if (!isIpv4(t.wakeHost) || !isIpv4(t.projectIp) || !isPort(t.appPort)) {
		throw new SafetyViolation('sleep.target', 'Adresse de réveil ou du projet invalide.');
	}
	const isApp = (x: { forwardHost: string; forwardPort: number }) => x.forwardHost === t.projectIp && x.forwardPort === t.appPort;
	const isWake = (x: { forwardHost: string; forwardPort: number }) => x.forwardHost === t.wakeHost && x.forwardPort === WAKE_PORT;
	if (!isApp(host) && !isWake(host)) {
		throw new SafetyViolation('sleep.from', `Le proxy host #${host.id} vise ${host.forwardHost}:${host.forwardPort}, ni le projet ni la page de réveil : on n'y touche pas.`);
	}
	if (!isApp(to) && !isWake(to)) {
		throw new SafetyViolation('sleep.to', `Cible refusée pour la mise en veille : ${to.forwardHost}:${to.forwardPort}.`);
	}
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function wakePageHtml(name: string, failed: string | null): string {
	const msg = failed ? `Le réveil a échoué (${esc(failed)}). Nouvel essai dans quelques secondes…` : 'Ce serveur de développement dormait. Il redémarre, la page se recharge toute seule (moins d’une minute en général).';
	return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="4"><title>Réveil en cours…</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0f0f10;color:#e8e6e3}main{max-width:28rem;padding:2rem;text-align:center}.d{width:2.5rem;height:2.5rem;margin:0 auto 1.5rem;border:3px solid #444;border-top-color:#f97316;border-radius:50%;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}p{color:#a8a29e;line-height:1.5}</style></head><body><main><div class="d"></div><h1>${esc(name)} se réveille</h1><p>${msg}</p></main></body></html>`;
}

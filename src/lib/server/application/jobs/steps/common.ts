import { INTERNET_PROBE_URL, parseInternetProbe, type InternetProbe } from '$lib/domain/firewall';
import { effectiveSize } from '$lib/domain/sizes';
import { ReadCommand } from '../../gateways';
import type { ProjectRow } from '$server/infrastructure/db/schema';
import { envAad } from '../../services';
import type { StepContext } from '../types';

export const RUNNER_HOME = '/home/github/actions-runner';

/** Dossier où le runner extrait le dépôt : _work/<repo>/<repo>. */
export function runnerRepoDir(p: ProjectRow): string {
	return `${RUNNER_HOME}/_work/${p.repoName}/${p.repoName}`;
}

export function sizeOf(p: ProjectRow) {
	return effectiveSize(p.size, p);
}

export function decryptEnv(ctx: StepContext): string {
	const p = ctx.project();
	if (!p.envEncrypted) return '';
	const text = ctx.services.cipher.decrypt(p.envEncrypted, envAad(p.id));
	// Chaque valeur du .env doit être masquée dans les logs.
	for (const line of text.split('\n')) {
		const idx = line.indexOf('=');
		if (idx > 0) ctx.services.redactor.add(line.slice(idx + 1).replace(/^["']|["']$/g, ''));
	}
	return text;
}

export function requireIp(ctx: StepContext): string {
	const ip = ctx.project().ip;
	if (!ip) throw new Error("Le projet n'a pas encore d'IP (étape « Conteneur » non terminée).");
	return ip;
}

/** Attend qu'une condition soit vraie (interrompable). */
export async function waitFor(
	ctx: StepContext,
	check: () => Promise<boolean>,
	opts: { intervalMs: number; timeoutMs: number; timeoutMessage: string; onTick?: (elapsedMs: number) => void }
): Promise<void> {
	const start = Date.now();
	while (true) {
		if (await check()) return;
		const elapsed = Date.now() - start;
		if (elapsed > opts.timeoutMs) throw new Error(opts.timeoutMessage);
		opts.onTick?.(elapsed);
		await ctx.sleep(opts.intervalMs);
	}
}

/** Commande à lancer sur l'hôte quand les CT avec pare-feu n'ont plus Internet. */
export const CONNTRACK_FIX = 'bash infra/07-conntrack-zone.sh';

/**
 * Vérifie que le CT joint Internet (le runner en a besoin) au lieu de laisser config.sh
 * bloqué sur « Authentication ». Avec firewall=1, l'absence de zone conntrack sur les
 * ponts fwbr casse le NAT : c'est la cause la plus probable.
 */
export async function assertCtInternet(ctx: StepContext, ip: string): Promise<void> {
	let last = 'down' as InternetProbe;
	await waitFor(
		ctx,
		async () => {
			const r = await ctx.services.shell.read({ ip, sshHostKey: ctx.project().sshHostKey }, ReadCommand.internet());
			last = parseInternetProbe(r.code, r.stdout);
			return last !== 'down';
		},
		{
			intervalMs: 5000,
			timeoutMs: 30_000,
			timeoutMessage: `Le CT n'a pas accès à Internet (${INTERNET_PROBE_URL} injoignable depuis ${ip}). Avec le pare-feu Proxmox (firewall=1), le NAT exige une zone conntrack sur les ponts fwbr : lancez sur l'hôte « ${CONNTRACK_FIX} », puis reprenez le job.`
		}
	);
	if (last === 'unknown') ctx.log('warn', 'curl absent du CT : accès Internet non vérifié.');
	else ctx.log('success', `Accès Internet du CT vérifié (${INTERNET_PROBE_URL}).`);
}

export function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const fmtDuration = (ms: number) => {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
};

import { effectiveSize } from '$lib/domain/sizes';
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

export function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const fmtDuration = (ms: number) => {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
};

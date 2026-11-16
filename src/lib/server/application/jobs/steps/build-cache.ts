/** Étape « Cache de build » : vide le cache Docker des builds du CT (rien d'autre). */
import { pruneBuildCacheCommand } from '$lib/domain/build-cache';
import type { StepDefinition } from '../types';

export const pruneCacheStep: StepDefinition = {
	key: 'prune_cache',
	label: 'Cache de build',
	async run(ctx) {
		const p = ctx.project();
		if (!p.ctid || !p.ip) throw new Error('Le projet n’a pas encore de CT.');
		const all = ctx.params.keepRecent !== true;
		ctx.log('info', all ? 'Vidage complet du cache de build Docker (conteneurs, images en service et volumes intacts).' : 'Nettoyage du cache de build (les couches récentes sont gardées).');
		const r = await ctx.services.shell.run({ ip: p.ip, sshHostKey: p.sshHostKey }, 'root', pruneBuildCacheCommand(all), {
			summary: all ? 'docker builder prune -a -f' : 'docker builder prune (garde 2 Go)',
			timeoutMs: 10 * 60_000
		});
		if (r.code !== 0) throw new Error(`Nettoyage échoué (code ${r.code}) : ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
		if (r.stdout.trim()) ctx.log('success', r.stdout.trim());
	}
};

/** Étape 7 — Premier pipeline : run GitHub Actions suivi jusqu'au bout, puis check HTTPS. */
import { WORKFLOW_FILE } from '$lib/domain/workflow';
import type { GhRun } from '../../ports';
import type { StepContext, StepDefinition } from '../types';
import { fmtDuration } from './common';

const CONCLUSION_FR: Record<string, string> = {
	success: 'réussi',
	failure: 'échoué',
	cancelled: 'annulé',
	skipped: 'ignoré',
	timed_out: 'délai dépassé'
};

async function findOrStartRun(ctx: StepContext): Promise<number | null> {
	const { github } = ctx.services;
	const p = ctx.project();
	if (typeof ctx.state.runId === 'number') return ctx.state.runId;

	// Le commit du workflow a déjà déclenché un run « push » : on le suit au lieu d'en lancer un second.
	const commitSha = ctx.stepState('workflow').commitSha as string | undefined;
	if (commitSha && !ctx.params.forceDispatch && !ctx.dryRun) {
		ctx.log('info', `Recherche du run déclenché par le commit ${commitSha.slice(0, 7)}…`);
		for (let i = 0; i < 6; i++) {
			const runs = await github.api.listWorkflowRuns(p.repoOwner, p.repoName, WORKFLOW_FILE, 10);
			const run = runs.find((r) => r.headSha === commitSha);
			if (run) {
				ctx.log('info', `Run #${run.runNumber} déjà déclenché par le commit du workflow : suivi de ce run.`);
				return run.id;
			}
			await ctx.sleep(3000);
		}
	}

	if (commitSha && !ctx.params.forceDispatch && !ctx.dryRun) ctx.log('info', 'Aucun run lié au commit : lancement manuel (workflow_dispatch).');
	const t0 = Date.now();
	const res = await github.dispatch(p.repoOwner, p.repoName, WORKFLOW_FILE, p.branch);
	if (ctx.dryRun) return null;
	if (res.runId) return res.runId;
	// Repli si l'API ne renvoie pas l'ID : le run le plus récent créé après le dispatch.
	for (let i = 0; i < 10; i++) {
		await ctx.sleep(3000);
		const runs = await github.api.listWorkflowRuns(p.repoOwner, p.repoName, WORKFLOW_FILE, 5);
		const run = runs.find((r) => r.event === 'workflow_dispatch' && Date.parse(r.createdAt) >= t0 - 5000);
		if (run) return run.id;
	}
	throw new Error('Le run lancé est introuvable sur GitHub après 30 s.');
}

async function followRun(ctx: StepContext, runId: number): Promise<GhRun> {
	const { github } = ctx.services;
	const p = ctx.project();
	const start = Date.now();
	const seenSteps = new Map<string, string>();
	let lastStatus = '';
	let warnedQueue = false;

	while (true) {
		const run = await github.api.getRun(p.repoOwner, p.repoName, runId);
		if (run.status !== lastStatus) {
			const fr: Record<string, string> = { queued: 'en file d’attente', in_progress: 'en cours', completed: 'terminé', waiting: 'en attente', pending: 'en attente' };
			ctx.log('info', `Run #${run.runNumber} : ${fr[run.status] ?? run.status} — ${run.htmlUrl}`);
			lastStatus = run.status;
		}
		if (run.status === 'queued' && !warnedQueue && Date.now() - start > 120_000) {
			ctx.log('warn', `Le run attend un runner depuis 2 min : vérifiez que le runner « ${p.slug} » est en ligne.`);
			warnedQueue = true;
		}
		const jobs = await github.api.getRunJobs(p.repoOwner, p.repoName, runId);
		for (const j of jobs) {
			for (const s of j.steps) {
				const key = `${j.id}:${s.number}`;
				const sig = `${s.status}:${s.conclusion}`;
				if (seenSteps.get(key) === sig) continue;
				seenSteps.set(key, sig);
				if (s.status === 'in_progress') ctx.log('info', `  ▸ ${s.name}…`);
				else if (s.status === 'completed' && s.conclusion === 'success') ctx.log('success', `  ✓ ${s.name}`);
				else if (s.status === 'completed' && s.conclusion === 'failure') ctx.log('error', `  ✗ ${s.name}`);
			}
		}
		if (run.status === 'completed') {
			ctx.state.conclusion = run.conclusion;
			ctx.save();
			return run;
		}
		if (Date.now() - start > 30 * 60_000) throw new Error(`Le run #${run.runNumber} n'est pas terminé après 30 min.`);
		await ctx.sleep(ctx.services.config.mode === 'mock' ? 1500 : 4000);
	}
}

export const pipelineStep: StepDefinition = {
	key: 'pipeline',
	label: 'Pipeline & vérification',
	async run(ctx) {
		const { github, repos, probe } = ctx.services;
		const p = ctx.project();
		const runId = await findOrStartRun(ctx);
		if (runId === null) {
			ctx.log('dry', '[DRY-RUN] Suivi du run GitHub simulé.');
		} else {
			ctx.state.runId = runId;
			ctx.save();
			const t0 = Date.now();
			const run = await followRun(ctx, runId);
			if (run.conclusion !== 'success') {
				const jobs = await github.api.getRunJobs(p.repoOwner, p.repoName, runId);
				const failed = jobs.find((j) => j.conclusion === 'failure');
				if (failed) {
					const logs = await github.api.getJobLogs(p.repoOwner, p.repoName, failed.id).catch(() => '');
					const tail = logs.split('\n').slice(-25);
					ctx.log('error', `Dernières lignes du job « ${failed.name} » :`);
					for (const l of tail) if (l.trim()) ctx.log('debug', ctx.services.redactor.redact(l));
				}
				delete ctx.state.runId;
				ctx.save();
				throw new Error(`Le run #${run.runNumber} a ${CONCLUSION_FR[run.conclusion ?? ''] ?? run.conclusion} : ${run.htmlUrl}`);
			}
			ctx.log('success', `Run #${run.runNumber} réussi en ${fmtDuration(Date.now() - t0)}.`);
		}

		if (ctx.params.skipHttpCheck) return;
		const domains = repos.domains.byProject(p.id);
		if (domains.length === 0) return;
		let anyOk = false;
		for (const d of domains) {
			const url = `https://${d.fqdn}`;
			let res = await probe().http(url);
			for (let i = 0; i < 5 && !res.ok && !ctx.dryRun; i++) {
				await ctx.sleep(ctx.services.config.mode === 'mock' ? 1000 : 8000);
				res = await probe().http(url);
			}
			if (res.ok) {
				anyOk = true;
				ctx.log('success', `${url} répond HTTP ${res.status} en ${res.ms} ms.`);
			} else {
				ctx.log(ctx.dryRun ? 'dry' : 'warn', `${url} : ${res.status ? `HTTP ${res.status}` : (res.error ?? 'injoignable')}.`);
			}
		}
		if (!anyOk && !ctx.dryRun) throw new Error("Aucun domaine ne répond en HTTPS (HTTP < 500). L'app écoute-t-elle bien sur le port configuré ?");
	}
};

/** Étape 4 — Workflow forge-deploy.yml (confirmation explicite avant le commit). */
import { findSelfHostedWorkflows, generateWorkflow, WORKFLOW_PATH } from '$lib/domain/workflow';
import type { StepDefinition } from '../types';

export const workflowStep: StepDefinition = {
	key: 'workflow',
	label: 'Workflow GitHub Actions',
	async run(ctx) {
		const { github } = ctx.services;
		const p = ctx.project();

		const existing = await github.api.getFile(p.repoOwner, p.repoName, WORKFLOW_PATH, p.branch);
		if (existing) {
			if (existing.content.includes(`self-hosted, ${p.slug}]`)) {
				ctx.log('success', `${WORKFLOW_PATH} déjà présent sur ${p.branch} : non modifié.`);
			} else {
				ctx.log('warn', `${WORKFLOW_PATH} existe mais ne cible pas le runner « ${p.slug} ». Forge ne le modifie pas : corrigez-le à la main.`);
			}
			ctx.state.existing = true;
			ctx.save();
			return;
		}

		const content = generateWorkflow({ slug: p.slug, branch: p.branch, mode: p.deployMode, ctid: p.ctid });

		// Détection des autres workflows self-hosted (risque de double déploiement).
		const entries = await github.api.listDir(p.repoOwner, p.repoName, '.github/workflows', p.branch);
		const files = await Promise.all(
			entries
				.filter((e) => e.type === 'file' && /\.ya?ml$/.test(e.name))
				.map(async (e) => ({ path: e.path, content: (await github.api.getFile(p.repoOwner, p.repoName, e.path, p.branch))?.content ?? '' }))
		);
		const conflicts = findSelfHostedWorkflows(files);
		const warnings = conflicts.map(
			(c) =>
				`${c.file} tourne aussi sur un runner self-hosted (${c.labels.join(', ')})${c.triggersOnPush ? ' et se déclenche à chaque push' : ''} : risque de double déploiement.`
		);
		for (const w of warnings) ctx.log('warn', w);

		if (!ctx.confirmed('workflow')) {
			ctx.log('info', 'En attente de votre confirmation pour commiter le workflow…');
			ctx.awaitInput({
				kind: 'workflow',
				title: `Commiter ${WORKFLOW_PATH} sur ${p.repoOwner}/${p.repoName}@${p.branch} ?`,
				payload: { path: WORKFLOW_PATH, branch: p.branch, repo: `${p.repoOwner}/${p.repoName}`, content, warnings }
			});
		}

		const res = await github.createWorkflowFile(p.repoOwner, p.repoName, WORKFLOW_PATH, content, p.branch);
		ctx.recordResource('gh_workflow', `${p.repoOwner}/${p.repoName}:${WORKFLOW_PATH}`, { sha: res.contentSha, commitSha: res.commitSha, branch: p.branch });
		ctx.state.commitSha = res.commitSha;
		ctx.state.committedAt = Date.now();
		ctx.save();
		ctx.log('success', `Workflow commité (${res.commitSha.slice(0, 7)}). Le push déclenche déjà un premier run.`);
	}
};

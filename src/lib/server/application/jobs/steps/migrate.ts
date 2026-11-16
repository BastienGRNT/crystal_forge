/**
 * Passage d'un projet au CT de build (après un premier déploiement réussi par le CT de build) :
 * workflow, secret, variables et runner GitHub retirés, CT nettoyé. Les volumes et le dossier
 * du projet (_work/<repo>/<repo>) sont conservés : la base et les fichiers ne bougent pas.
 */
import { githubEnvironmentFor, workflowPathFor } from '$lib/domain/environments';
import { errorMessage } from '$lib/domain/errors';
import { workflowVersion } from '$lib/domain/workflow';
import type { StepDefinition } from '../types';
import { RUNNER_HOME, requireIp, shq } from './common';
import { teardownResource } from './maintenance';

/** Nettoie le CT : cache de build et images inutilisées (jamais les volumes ni les images en service). */
export const CLEAN_CT_COMMAND = ': forge-build=clean; docker builder prune -af | tail -n 1; docker image prune -f | tail -n 1; df -h / | tail -n 1';

export const removeRunnerStep: StepDefinition = {
	key: 'remove_runner',
	label: 'Retrait du runner GitHub',
	async run(ctx) {
		const { github, shell, repos } = ctx.services;
		const p = ctx.project();
		const ip = requireIp(ctx);
		const repo = `${p.repoOwner}/${p.repoName}`;
		const environment = githubEnvironmentFor(p.environment);
		const warn = (what: string, err: unknown) => ctx.log('warn', `${what} : ${errorMessage(err)}`);

		// --- 1. Workflow : sans runner, il resterait « en attente » à chaque push ------------------
		const path = workflowPathFor(p.environment);
		const file = await github.api.getFile(p.repoOwner, p.repoName, path, p.branch).catch(() => null);
		if (!file) {
			ctx.log('info', `${path} déjà absent.`);
		} else if (workflowVersion(file.content) === null) {
			ctx.log('warn', `${path} n'a pas été généré par Forge : conservé.`);
		} else {
			const id = `${repo}:${path}`;
			if (!ctx.dryRun) repos.resources.record({ type: 'gh_workflow', externalId: id, projectId: p.id, jobId: ctx.job.id, meta: { sha: file.sha, branch: p.branch } });
			try {
				await github.deleteWorkflowFile(p.repoOwner, p.repoName, path, file.sha, p.branch);
				if (!ctx.dryRun) repos.resources.markDeleted('gh_workflow', id);
				ctx.log('success', `${path} supprimé du dépôt.`);
				// Ce commit ne change pas le code : il ne doit pas déclencher un redéploiement.
				if (!ctx.dryRun) {
					const head = await github.api.latestCommit(p.repoOwner, p.repoName, p.branch).catch(() => null);
					if (head) ctx.updateProject({ deployedSha: head.sha });
				}
			} catch (err) {
				warn(`Suppression de ${path}`, err);
			}
		}

		// --- 2. Secret ENV_FILE, variables FORGE_* et runner ------------------------------------------
		const owned = repos.resources.active({ projectId: p.id }).filter((r) => r.type === 'gh_secret' || r.type === 'gh_variable' || r.type === 'gh_runner');
		for (const r of owned) await teardownResource(ctx, r).catch((err) => warn(`${r.type} ${r.externalId}`, err));
		const leftover = ctx.dryRun ? [] : await github.api.listVariables(p.repoOwner, p.repoName, environment).catch(() => []);
		for (const v of leftover.filter((x) => x.name.startsWith('FORGE_'))) {
			await github.deleteVariable(p.repoOwner, p.repoName, v.name, environment).catch((err) => warn(`Variable ${v.name}`, err));
		}
		if (!ctx.dryRun) {
			const stray = (await github.api.listRunners(p.repoOwner, p.repoName).catch(() => [])).filter((r) => r.name === p.slug);
			for (const r of stray) {
				repos.resources.record({ type: 'gh_runner', externalId: `${repo}:${r.id}`, projectId: p.id, jobId: ctx.job.id, meta: { name: r.name } });
				await github.deleteRunner(p.repoOwner, p.repoName, r.id).then(
					() => repos.resources.markDeleted('gh_runner', `${repo}:${r.id}`),
					(err) => warn(`Runner #${r.id}`, err)
				);
			}
		}
		ctx.log('success', 'Secret, variables et runner retirés de GitHub.');

		// --- 3. Service du runner et ses fichiers (le dossier du projet est gardé) ------------------
		const keep = shq(p.repoName);
		const cmd = [
			`cd ${RUNNER_HOME} 2>/dev/null || exit 0`,
			'if [ -f .service ]; then ./svc.sh stop || true; ./svc.sh uninstall || true; fi',
			`find ${RUNNER_HOME} -mindepth 1 -maxdepth 1 ! -name _work -exec rm -rf {} +`,
			`if [ -d _work ]; then find ${RUNNER_HOME}/_work -mindepth 1 -maxdepth 1 ! -name ${keep} -exec rm -rf {} +; fi`,
			'echo ok'
		].join('; ');
		const r1 = await shell.run({ ip, sshHostKey: p.sshHostKey }, 'root', cmd, { summary: `Arrêter et désinstaller le runner, supprimer ${RUNNER_HOME} sauf _work/${p.repoName}`, timeoutMs: 3 * 60_000 });
		if (r1.code !== 0) throw new Error(`Retrait du runner dans le CT : ${(r1.stderr || r1.stdout).trim().slice(-400)}`);
		ctx.log('success', 'Runner arrêté et désinstallé du CT (code et données du projet conservés).');

		// --- 4. Nettoyage du CT -------------------------------------------------------------------
		const r2 = await shell.run({ ip, sshHostKey: p.sshHostKey }, 'root', CLEAN_CT_COMMAND, { summary: 'docker builder prune -af ; docker image prune -f', timeoutMs: 10 * 60_000 });
		for (const l of r2.stdout.split('\n').filter((x) => x.trim())) ctx.log('info', l.trim());

		if (!ctx.dryRun) ctx.updateProject({ buildMode: 'builder' });
		ctx.log('success', `Projet passé sur le CT de build : chaque push sur ${p.branch} est déployé automatiquement par Forge.`);
		ctx.log('info', "Le CT ne construit plus rien : sa RAM peut être réduite (onglet Conteneur → Taille) si l'app consomme peu.");
	}
};

/** Nettoyage simple d'un CT (bouton « Nettoyer ») : cache de build et images inutilisées. */
export const cleanCtStep: StepDefinition = {
	key: 'clean_ct',
	label: 'Nettoyage du CT',
	async run(ctx) {
		const p = ctx.project();
		const ip = requireIp(ctx);
		const r = await ctx.services.shell.run({ ip, sshHostKey: p.sshHostKey }, 'root', CLEAN_CT_COMMAND, { summary: 'docker builder prune -af ; docker image prune -f', timeoutMs: 10 * 60_000 });
		if (r.code !== 0) throw new Error(`Nettoyage échoué (code ${r.code}) : ${(r.stderr || r.stdout).trim().slice(-300)}`);
		for (const l of r.stdout.split('\n').filter((x) => x.trim())) ctx.log('success', l.trim());
	}
};

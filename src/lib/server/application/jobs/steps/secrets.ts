/** Étape 3 — Secret ENV_FILE et variables FORGE_* du dépôt. */
import { FORGE_SECRET_NAME } from '$lib/domain/safety-policy';
import { githubEnvironmentFor } from '$lib/domain/environments';
import { buildRepoVariables } from '$lib/domain/workflow';
import type { StepDefinition } from '../types';
import { decryptEnv } from './common';

export const secretsStep: StepDefinition = {
	key: 'secrets',
	label: 'Secrets & variables',
	async run(ctx) {
		const { github } = ctx.services;
		const p = ctx.project();
		const repo = `${p.repoOwner}/${p.repoName}`;
		// Serveur de dev : secret et variables dans l'environnement GitHub « development », qui prend le
		// pas sur le dépôt sans toucher à ceux de la production.
		const environment = githubEnvironmentFor(p.environment);
		const scope = environment ? `${environment}:` : '';
		if (environment) await github.ensureEnvironment(p.repoOwner, p.repoName, environment);

		const env = ctx.params.onlyVars ? null : decryptEnv(ctx);
		if (env === null) {
			ctx.log('info', 'Secret ENV_FILE inchangé.');
		} else if (env.trim() === '') {
			ctx.log('warn', 'Le .env est vide : aucun secret ENV_FILE écrit (le workflow créera un .env vide).');
		} else {
			await github.putEnvSecret(p.repoOwner, p.repoName, env, environment);
			ctx.recordResource('gh_secret', `${repo}:${scope}${FORGE_SECRET_NAME}`);
			const keys = env.split('\n').filter((l) => /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_.-]*=/.test(l)).length;
			ctx.log('success', `Secret ${FORGE_SECRET_NAME} écrit (${keys} variable(s), valeurs jamais journalisées).`);
		}
		if (ctx.params.onlyEnv) return;

		const vars = buildRepoVariables({
			mode: p.deployMode,
			composeFile: p.composeFile,
			workdir: p.workdir,
			postDeploy: p.postDeploy,
			appService: p.appService,
			appPort: p.appPort,
			dbService: p.dbService,
			dbKind: p.dbKind
		});
		const current = ctx.dryRun ? [] : await github.api.listVariables(p.repoOwner, p.repoName, environment);
		for (const [name, value] of Object.entries(vars)) {
			if (value === '') {
				if (current.some((v) => v.name === name)) {
					await github.deleteVariable(p.repoOwner, p.repoName, name, environment);
					ctx.log('info', `Variable ${name} supprimée (vide).`);
				}
				continue;
			}
			if (current.find((v) => v.name === name)?.value === value) continue;
			await github.setVariable(p.repoOwner, p.repoName, name, value, environment);
			ctx.recordResource('gh_variable', `${repo}:${scope}${name}`);
		}
		ctx.log('success', `Variables de dépôt : ${Object.entries(vars).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${v}`).join(', ')}`);
	}
};

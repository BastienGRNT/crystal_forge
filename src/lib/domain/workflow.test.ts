import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildRepoVariables, findSelfHostedWorkflows, generateWorkflow, GENERATED_COMPOSE_FILE } from './workflow';
import { assertSafeCommand } from './safety-policy';

describe('generateWorkflow', () => {
	const yml = generateWorkflow({ slug: 'demo-app', branch: 'main', mode: 'compose', ctid: 500 });
	const doc = parse(yml);

	it('produit un YAML valide avec push sur la branche + workflow_dispatch', () => {
		expect(doc.on.push.branches).toEqual(['main']);
		expect(doc.on).toHaveProperty('workflow_dispatch');
	});

	it('cible le runner du projet et empêche deux déploiements simultanés', () => {
		expect(doc.jobs.deploy['runs-on']).toEqual(['self-hosted', 'demo-app']);
		expect(doc.concurrency).toEqual({ group: 'forge-deploy-demo-app', 'cancel-in-progress': false });
	});

	it("écrit .env depuis ENV_FILE via env: sans interpolation dans le script", () => {
		const step = doc.jobs.deploy.steps.find((s: { name: string }) => s.name === 'Écrire le fichier .env');
		expect(step.env.ENV_FILE).toBe('${{ secrets.ENV_FILE }}');
		expect(step.run).toContain(`printf '%s' "$ENV_FILE" > .env`);
		expect(step.run).not.toContain('secrets.');
	});

	it("n'interpole aucune expression ${{ }} dans les scripts run", () => {
		for (const step of doc.jobs.deploy.steps) {
			if (step.run) expect(step.run).not.toMatch(/\$\{\{/);
		}
	});

	it('ne contient jamais de down -v ni de suppression de volume', () => {
		expect(yml).not.toMatch(/down\s+-v/);
		expect(yml).not.toMatch(/--volumes/);
		expect(yml).not.toMatch(/volume\s+rm/);
		for (const step of doc.jobs.deploy.steps) {
			if (step.run) expect(() => assertSafeCommand(step.run)).not.toThrow();
		}
	});

	it('lance compose up --build --remove-orphans puis le post-déploiement conditionnel', () => {
		const runs = doc.jobs.deploy.steps.map((s: { run?: string }) => s.run ?? '').join('\n');
		expect(runs).toContain('docker compose -f "$FORGE_COMPOSE_FILE" up -d --build --remove-orphans');
		const post = doc.jobs.deploy.steps.find((s: { name: string }) => s.name === 'Post-déploiement');
		expect(post.if).toBe("${{ vars.FORGE_POST_DEPLOY != '' }}");
		expect(post.run).toContain('exec -T');
		expect(runs).toContain('docker image prune -f');
	});

	it('mode Dockerfile : génère un compose minimal', () => {
		const d = parse(generateWorkflow({ slug: 'solo', branch: 'master', mode: 'dockerfile' }));
		const gen = d.jobs.deploy.steps.find((s: { name: string }) => s.name.startsWith('Générer le fichier compose'));
		expect(gen.run).toContain('env_file: .env');
		expect(d.on.push.branches).toEqual(['master']);
		const vars = buildRepoVariables({ mode: 'dockerfile', composeFile: null, workdir: '.', postDeploy: '', appService: 'web', appPort: 8080 });
		expect(vars.FORGE_COMPOSE_FILE).toBe(GENERATED_COMPOSE_FILE);
		expect(vars.FORGE_APP_SERVICE).toBe('app');
	});

	it('refuse un slug ou une branche dangereux', () => {
		expect(() => generateWorkflow({ slug: 'x; rm -rf', branch: 'main', mode: 'compose' })).toThrow();
		expect(() => generateWorkflow({ slug: 'ok', branch: 'main"\n', mode: 'compose' })).toThrow();
	});
});

describe('findSelfHostedWorkflows', () => {
	it('détecte les workflows self-hosted existants (risque de double déploiement)', () => {
		const res = findSelfHostedWorkflows([
			{ path: '.github/workflows/deploy.yml', content: 'on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: self-hosted\n    steps: []' },
			{ path: '.github/workflows/ci.yml', content: 'on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps: []' },
			{ path: '.github/workflows/forge-deploy.yml', content: 'jobs:\n  d:\n    runs-on: [self-hosted, x]' },
			{ path: '.github/workflows/obj.yml', content: 'on: [push]\njobs:\n  a:\n    runs-on:\n      labels: [self-hosted, linux]' }
		]);
		expect(res.map((r) => r.file)).toEqual(['.github/workflows/deploy.yml', '.github/workflows/obj.yml']);
		expect(res.every((r) => r.triggersOnPush)).toBe(true);
	});
});

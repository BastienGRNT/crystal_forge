import { parse as parseYaml } from 'yaml';
import type { DeployMode } from './compose-detect';
import { isSqlDbKind } from './compose-analysis';
import { workflowBackupScript } from './database';

export const WORKFLOW_PATH = '.github/workflows/forge-deploy.yml';
export const WORKFLOW_FILE = 'forge-deploy.yml';
/**
 * Version du workflow généré. À incrémenter à chaque changement du modèle :
 * « Mettre à niveau le projet » propose alors la nouvelle version aux projets existants.
 *   1 : version initiale
 *   2 : sauvegarde de la base avant déploiement (FORGE_DB_SERVICE / FORGE_DB_KIND)
 *   3 : en-tête corrigé (Forge peut mettre le fichier à niveau, après confirmation)
 */
export const WORKFLOW_VERSION = 3;
export const CHECKOUT_ACTION = 'actions/checkout@v7';
/** Fichier compose généré par le workflow en mode « Dockerfile seul ». */
export const GENERATED_COMPOSE_FILE = '.forge-compose.yml';

export interface WorkflowOptions {
	slug: string;
	branch: string;
	mode: DeployMode;
	ctid?: number | null;
}

/** Variables de dépôt (non secrètes) lues par le workflow. */
export interface ForgeRepoVariables {
	FORGE_COMPOSE_FILE: string;
	FORGE_WORKDIR: string;
	FORGE_POST_DEPLOY: string;
	FORGE_APP_SERVICE: string;
	FORGE_APP_PORT: string;
	/** Service de la base sauvegardée avant chaque déploiement ('' = pas de sauvegarde). */
	FORGE_DB_SERVICE: string;
	FORGE_DB_KIND: string;
}

export function buildRepoVariables(input: {
	mode: DeployMode;
	composeFile: string | null;
	workdir: string;
	postDeploy: string | null;
	appService: string;
	appPort: number;
	dbService?: string | null;
	dbKind?: string | null;
}): ForgeRepoVariables {
	const db = input.dbService && isSqlDbKind(input.dbKind) && input.mode === 'compose';
	return {
		FORGE_COMPOSE_FILE: input.mode === 'dockerfile' ? GENERATED_COMPOSE_FILE : (input.composeFile ?? 'docker-compose.yml'),
		FORGE_WORKDIR: input.workdir || '.',
		FORGE_POST_DEPLOY: (input.postDeploy ?? '').trim(),
		FORGE_APP_SERVICE: input.mode === 'dockerfile' ? 'app' : input.appService,
		FORGE_APP_PORT: String(input.appPort),
		FORGE_DB_SERVICE: db ? (input.dbService as string) : '',
		FORGE_DB_KIND: db ? (input.dbKind as string) : ''
	};
}

function assertSafeIdentifier(name: string, value: string) {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) throw new Error(`${name} invalide pour le workflow : ${value}`);
}

function assertSafeBranch(branch: string) {
	if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..')) {
		throw new Error(`Branche invalide pour le workflow : ${branch}`);
	}
}

/**
 * Génère .github/workflows/forge-deploy.yml.
 * Règles : runs-on [self-hosted, <slug>], concurrence, .env écrit depuis ENV_FILE
 * via `env:` (jamais interpolé dans le script), aucun `down -v`.
 */
export function generateWorkflow(opts: WorkflowOptions): string {
	assertSafeIdentifier('Slug', opts.slug);
	assertSafeBranch(opts.branch);
	const { slug, branch } = opts;
	const ctNote = opts.ctid ? ` du CT ${opts.ctid}` : '';

	const dockerfileStep =
		opts.mode === 'dockerfile'
			? `
      - name: Générer le fichier compose (mode Dockerfile seul)
        run: |
          set -euo pipefail
          cd "\${FORGE_WORKDIR:-.}"
          cat > "$FORGE_COMPOSE_FILE" <<EOF
          services:
            app:
              build: .
              env_file: .env
              restart: unless-stopped
              ports:
                - "\${FORGE_APP_PORT}:\${FORGE_APP_PORT}"
          EOF
`
			: '';

	return `# ──────────────────────────────────────────────────────────────────────
# Généré par Forge pour le projet « ${slug} ».
# forge-workflow-version: ${WORKFLOW_VERSION}
# S'exécute sur le runner self-hosted${ctNote} (label « ${slug} »).
# Configuration : variables de dépôt FORGE_* et secret ENV_FILE, modifiables
# depuis Forge. Forge ne réécrit ce fichier que sur « Mettre à niveau le
# projet », après confirmation, et seulement s'il n'a pas été modifié à la main.
# Aucune commande de ce workflow ne supprime de volume Docker.
# Si FORGE_DB_SERVICE est défini, la base est sauvegardée avant chaque
# déploiement dans /home/github/forge-backups (10 dernières conservées).
# ──────────────────────────────────────────────────────────────────────
name: Forge · Déploiement

on:
  push:
    branches: ["${branch}"]
  workflow_dispatch:

concurrency:
  group: forge-deploy-${slug}
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  deploy:
    name: Déployer ${slug}
    runs-on: [self-hosted, ${slug}]
    timeout-minutes: 30
    env:
      FORGE_COMPOSE_FILE: \${{ vars.FORGE_COMPOSE_FILE }}
      FORGE_WORKDIR: \${{ vars.FORGE_WORKDIR }}
      FORGE_POST_DEPLOY: \${{ vars.FORGE_POST_DEPLOY }}
      FORGE_APP_SERVICE: \${{ vars.FORGE_APP_SERVICE }}
      FORGE_APP_PORT: \${{ vars.FORGE_APP_PORT }}
      FORGE_DB_SERVICE: \${{ vars.FORGE_DB_SERVICE }}
      FORGE_DB_KIND: \${{ vars.FORGE_DB_KIND }}
    defaults:
      run:
        shell: bash
    steps:
      - name: Récupérer le code
        uses: ${CHECKOUT_ACTION}

      - name: Écrire le fichier .env
        env:
          ENV_FILE: \${{ secrets.ENV_FILE }}
        run: |
          set -euo pipefail
          cd "\${FORGE_WORKDIR:-.}"
          umask 077
          printf '%s' "$ENV_FILE" > .env
${dockerfileStep}
      - name: Sauvegarder la base (avant déploiement)
        if: \${{ vars.FORGE_DB_SERVICE != '' }}
        run: |
${indent(workflowBackupScript(slug), 10)}

      - name: Construire et démarrer
        run: |
          set -euo pipefail
          cd "\${FORGE_WORKDIR:-.}"
          docker compose -f "$FORGE_COMPOSE_FILE" up -d --build --remove-orphans

      - name: Post-déploiement
        if: \${{ vars.FORGE_POST_DEPLOY != '' }}
        run: |
          set -euo pipefail
          cd "\${FORGE_WORKDIR:-.}"
          docker compose -f "$FORGE_COMPOSE_FILE" exec -T "\${FORGE_APP_SERVICE:-app}" sh -c "$FORGE_POST_DEPLOY"

      - name: Nettoyer les images inutilisées
        if: always()
        run: docker image prune -f
`;
}

function indent(text: string, n: number): string {
	const pad = ' '.repeat(n);
	return text
		.split('\n')
		.map((l) => (l ? pad + l : l))
		.join('\n');
}

/** Version d'un workflow Forge (1 pour ceux générés avant l'ajout du marqueur), null si ce n'en est pas un. */
export function workflowVersion(content: string): number | null {
	const m = /^# forge-workflow-version: (\d+)$/m.exec(content);
	if (m) return Number(m[1]);
	return content.includes('Généré par Forge') ? 1 : null;
}

export { lineDiff, type DiffLine } from './diff';

/** Forme de `runs-on` dans un workflow GitHub Actions. */
function runsOnLabels(runsOn: unknown): string[] {
	if (typeof runsOn === 'string') return [runsOn];
	if (Array.isArray(runsOn)) return runsOn.filter((x): x is string => typeof x === 'string');
	if (runsOn && typeof runsOn === 'object') {
		const labels = (runsOn as { labels?: unknown }).labels;
		if (typeof labels === 'string') return [labels];
		if (Array.isArray(labels)) return labels.filter((x): x is string => typeof x === 'string');
	}
	return [];
}

export interface SelfHostedUsage {
	file: string;
	jobs: string[];
	labels: string[];
	triggersOnPush: boolean;
}

/** Détecte les workflows existants qui tournent sur un runner self-hosted (risque de double déploiement). */
export function findSelfHostedWorkflows(files: { path: string; content: string }[]): SelfHostedUsage[] {
	const out: SelfHostedUsage[] = [];
	for (const f of files) {
		if (f.path.endsWith(WORKFLOW_FILE)) continue;
		let doc: unknown;
		try {
			doc = parseYaml(f.content);
		} catch {
			continue;
		}
		if (!doc || typeof doc !== 'object') continue;
		const jobs = (doc as { jobs?: Record<string, { 'runs-on'?: unknown }> }).jobs ?? {};
		const hits: string[] = [];
		const labels = new Set<string>();
		for (const [name, job] of Object.entries(jobs)) {
			const l = runsOnLabels(job?.['runs-on']);
			if (l.some((x) => x.toLowerCase() === 'self-hosted')) {
				hits.push(name);
				l.forEach((x) => labels.add(x));
			}
		}
		if (hits.length === 0) continue;
		const on = (doc as Record<string, unknown>).on ?? (doc as Record<string, unknown>)[true as unknown as string];
		const triggersOnPush =
			on === 'push' ||
			(Array.isArray(on) && on.includes('push')) ||
			(!!on && typeof on === 'object' && 'push' in (on as object));
		out.push({ file: f.path, jobs: hits, labels: [...labels], triggersOnPush });
	}
	return out;
}

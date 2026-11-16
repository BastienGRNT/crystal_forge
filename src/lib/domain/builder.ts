/**
 * Déploiement par le CT de build (sans runner GitHub ni build dans les CT de projet) :
 *   1. Forge télécharge l'archive du commit sur GitHub ;
 *   2. le CT de build construit les images (un projet à la fois) ;
 *   3. Forge transfère les images (docker save | docker load) dans le CT du projet ;
 *   4. le CT du projet redémarre les services sans rien construire.
 * Ce module ne contient que des règles pures : chemins, commandes, lecture des sorties.
 */
import { SafetyViolation } from './errors';

/** Dossier des projets déployés par Forge dans leur CT (utilisateur github). */
export const DEPLOY_ROOT = '/home/github/forge';
/** Dossier de travail du CT de build (sources effacées après chaque build). */
export const BUILD_ROOT = '/root/forge-build';
/** Nom du CT de build dans Proxmox. */
export const BUILDER_HOSTNAME = 'forge-builder';

const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

/** Dossier de déploiement d'un nouveau projet. */
export function newDeployDir(repoName: string): string {
	return assertDeployDir(`${DEPLOY_ROOT}/${repoName}`);
}

/** Seuls les dossiers sous /home/github sont écrits dans un CT de projet. */
export function assertDeployDir(dir: string): string {
	if (!SAFE_PATH.test(dir) || dir.includes('..') || !dir.startsWith('/home/github/') || dir.split('/').length < 4) {
		throw new SafetyViolation('deploy.dir', `Dossier de déploiement refusé : ${dir}`);
	}
	return dir;
}

/** Sous-dossier du dépôt (« . », « apps/web ») : relatif, sans remontée. */
export function assertWorkdir(workdir: string): string {
	const w = workdir || '.';
	if (w !== '.' && (!/^[A-Za-z0-9._/-]+$/.test(w) || w.startsWith('/') || w.split('/').includes('..'))) {
		throw new SafetyViolation('deploy.workdir', `Sous-dossier refusé : ${workdir}`);
	}
	return w;
}

export function buildDir(slug: string): string {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new SafetyViolation('build.slug', `Projet invalide : ${slug}`);
	return `${BUILD_ROOT}/${slug}`;
}

/** Nom de projet compose (préfixe des images et des volumes). */
export function assertComposeName(name: string): string {
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new SafetyViolation('compose.name', `Nom de projet compose invalide : ${name}`);
	return name;
}

const IMAGE_RE = /^[a-z0-9][a-z0-9._/:@-]*$/;

/**
 * `docker compose config --format json` → nom du projet et images construites
 * (services avec « build »). Image par défaut : <projet>-<service>.
 */
export function parseComposeConfig(json: string): { name: string; built: { service: string; image: string }[] } {
	let cfg: { name?: unknown; services?: Record<string, { build?: unknown; image?: unknown }> };
	try {
		cfg = JSON.parse(json.slice(json.indexOf('{')));
	} catch {
		throw new Error('Configuration compose illisible.');
	}
	const name = assertComposeName(String(cfg.name ?? ''));
	const built = Object.entries(cfg.services ?? {})
		.filter(([, s]) => s && s.build)
		.map(([service, s]) => {
			const image = typeof s.image === 'string' && s.image ? s.image : `${name}-${service}`;
			if (!IMAGE_RE.test(image)) throw new SafetyViolation('compose.image', `Nom d'image refusé : ${image}`);
			return { service, image };
		});
	return { name, built };
}

/** Variables exigées par le compose (« ${VAR:?} ») mais absentes du .env. */
export function missingVariables(output: string): string[] {
	const found = new Set<string>();
	for (const m of output.matchAll(/required variable ([A-Za-z_][A-Za-z0-9_]*) is missing/g)) found.add(m[1] as string);
	for (const m of output.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)" variable is not set/g)) found.add(m[1] as string);
	return [...found];
}

/** Compose généré en mode « Dockerfile seul » (identique à celui de l'ancien workflow). */
export function dockerfileCompose(appPort: number): string {
	if (!Number.isInteger(appPort) || appPort < 1 || appPort > 65535) throw new Error(`Port invalide : ${appPort}`);
	return `services:\n  app:\n    build: .\n    env_file: .env\n    restart: unless-stopped\n    ports:\n      - "${appPort}:${appPort}"\n`;
}

/** Le CT de build peut-il démarrer sans faire swapper l'hôte ? */
export function builderFits(hostUsed: number, hostTotal: number, builderMem: number, margin = 1024 ** 3): boolean {
	return hostUsed + builderMem <= hostTotal - margin;
}

/** Nom de projet compose déduit du dossier (comme docker compose sans « name: » ni « -p »). */
export function composeProjectName(dir: string): string {
	const base = dir.replace(/\/+(\.)?$/, '').split('/').filter((x) => x && x !== '.').pop() ?? '';
	return base.toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[^a-z0-9]+/, '');
}

/** Ligne de `docker ps --format '{{json .}}'` → service compose (étiquette). */
export function composeServiceOf(labels: string): string {
	return /(?:^|,)com\.docker\.compose\.service=([^,]+)/.exec(labels)?.[1] ?? '';
}

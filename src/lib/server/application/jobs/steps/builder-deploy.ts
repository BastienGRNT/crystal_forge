/**
 * Déploiement sans runner GitHub :
 *   archive du commit → CT du projet (sources, .env) → CT de build (docker compose build)
 *   → images transférées (docker save | docker load) → CT du projet : up -d --no-build.
 * Si le CT de build ne peut pas s'allumer (RAM), le CT du projet construit lui-même, une image à la fois.
 * Rien n'est jamais supprimé dans le dossier du projet ; les volumes Docker ne sont pas touchés.
 */
import { assertComposeName, assertDeployDir, assertWorkdir, buildDir, dockerfileCompose, missingVariables, parseComposeConfig } from '$lib/domain/builder';
import { workflowBackupScript } from '$lib/domain/database';
import { buildRepoVariables, GENERATED_COMPOSE_FILE } from '$lib/domain/workflow';
import { formatBytes } from '$lib/domain/build-cache';
import { ensureBuilder, markBuilderUse } from '../../builder';
import type { ShellTarget } from '../../gateways';
import type { StepContext } from '../types';
import { decryptEnv, fmtDuration, projectDir, requireIp, shq } from './common';

const NO_PARALLEL = 'COMPOSE_BAKE=false COMPOSE_PARALLEL_LIMIT=1';

export async function builderDeploy(ctx: StepContext): Promise<void> {
	const { github, shell, redactor } = ctx.services;
	const p = ctx.project();
	const ip = requireIp(ctx);
	const ct = (): ShellTarget => ({ ip, sshHostKey: ctx.project().sshHostKey });
	const dir = assertDeployDir(projectDir(p));
	const workdir = assertWorkdir(p.workdir);
	const vars = buildRepoVariables({
		mode: p.deployMode,
		composeFile: p.composeFile,
		workdir,
		postDeploy: p.postDeploy,
		appService: p.appService,
		appPort: p.appPort,
		dbService: p.dbService,
		dbKind: p.dbKind
	});
	const composeFile = p.deployMode === 'dockerfile' ? GENERATED_COMPOSE_FILE : vars.FORGE_COMPOSE_FILE;
	const wd = workdir === '.' ? dir : `${dir}/${workdir}`;
	const F = shq(composeFile);
	const out = (s: string) =>
		s
			.split('\n')
			.filter((l) => l.trim())
			.forEach((l) => ctx.log('debug', redactor.redact(l)));
	const t0 = Date.now();

	// --- 1. Commit à déployer ---------------------------------------------------------------
	const sha = typeof ctx.params.sha === 'string' && /^[0-9a-f]{40}$/.test(ctx.params.sha) ? ctx.params.sha : (await github.api.latestCommit(p.repoOwner, p.repoName, p.branch)).sha;
	ctx.state.sha = sha;
	ctx.save();
	ctx.log('info', `Déploiement du commit ${sha.slice(0, 7)} (${p.repoOwner}/${p.repoName}@${p.branch}).`);
	const tarball = await github.api.downloadTarball(p.repoOwner, p.repoName, sha);
	ctx.log('info', `Archive du code téléchargée (${formatBytes(tarball.length)}).`);
	const envText = decryptEnv(ctx);
	const envBuf = Buffer.from(envText.endsWith('\n') || !envText ? envText : `${envText}\n`);

	// --- 2. CT du projet : sources + .env (aucun fichier supprimé) -----------------------------
	const run = async (t: ShellTarget, user: 'root' | 'github', command: string, summary: string, opts: { stdin?: Buffer; timeoutMs?: number; quiet?: boolean } = {}) => {
		const r = await shell.run(t, user, command, { summary, stdin: opts.stdin, timeoutMs: opts.timeoutMs ?? 5 * 60_000, onOutput: opts.quiet ? undefined : out });
		if (r.code !== 0) {
			const text = `${r.stderr}\n${r.stdout}`;
			const missing = missingVariables(text);
			if (missing.length) throw new Error(`Variable(s) absente(s) du .env : ${missing.join(', ')}. Ajoutez-les dans l'onglet Variables (ou rendez-les facultatives dans le compose : \${VAR:-}), puis relancez.`);
			throw new Error(`${summary} : échec (code ${r.code}) — ${redactor.redact(text.trim()).slice(-600)}`);
		}
		return r;
	};
	await run(ct(), 'github', `mkdir -p ${shq(dir)} && tar -xzf - -C ${shq(dir)} --strip-components=1 --no-same-owner`, `Extraire le code dans ${dir}`, { stdin: tarball });
	await run(ct(), 'github', `cd ${shq(wd)} && umask 077 && cat > .env`, `Écrire ${wd}/.env (valeurs jamais journalisées)`, { stdin: envBuf, quiet: true });
	if (p.deployMode === 'dockerfile') {
		await run(ct(), 'github', `cd ${shq(wd)} && cat > ${F}`, `Écrire ${composeFile} (mode Dockerfile seul)`, { stdin: Buffer.from(dockerfileCompose(p.appPort)) });
	}
	const cfg = await run(ct(), 'github', `cd ${shq(wd)} && : forge-build=config; docker compose -f ${F} config --format json`, 'Lire la configuration compose', { quiet: true });
	// Le nom du projet compose vient du CT (dossier) : les images et volumes gardent leur nom.
	const { name, built } = ctx.dryRun ? { name: 'simulation', built: [] as { service: string; image: string }[] } : parseComposeConfig(cfg.stdout);
	assertComposeName(name);
	ctx.log('info', built.length ? `Images à construire : ${built.map((b) => b.image).join(', ')}.` : 'Aucune image à construire (images publiques uniquement).');

	// --- 3. Build -----------------------------------------------------------------------------
	let builtElsewhere = false;
	if (built.length) {
		markBuilderUse(1);
		try {
			// Le CT de build ne doit jamais bloquer un déploiement : en cas d'échec, on construit dans le CT.
			const b = await ensureBuilder(ctx.services, (l, m) => ctx.log(l, m), ctx.dryRun).catch((err) => {
				ctx.log('warn', `CT de build indisponible : ${err instanceof Error ? err.message : err}`);
				ctx.log('warn', 'Construction dans le CT du projet à la place (une image à la fois).');
				return null;
			});
			if (b) {
				const bdir = buildDir(p.slug);
				const bwd = workdir === '.' ? bdir : `${bdir}/${workdir}`;
				ctx.log('info', `Construction sur le CT de build (${b.ip})…`);
				await run(b, 'root', `rm -rf ${shq(bdir)} && mkdir -p ${shq(bdir)} && tar -xzf - -C ${shq(bdir)} --strip-components=1 --no-same-owner`, `Préparer ${bdir} sur le CT de build`, { stdin: tarball });
				await run(b, 'root', `cd ${shq(bwd)} && umask 077 && cat > .env`, 'Écrire le .env de build', { stdin: envBuf, quiet: true });
				if (p.deployMode === 'dockerfile') await run(b, 'root', `cd ${shq(bwd)} && cat > ${F}`, `Écrire ${composeFile}`, { stdin: Buffer.from(dockerfileCompose(p.appPort)) });
				const tb = Date.now();
				await run(b, 'root', `cd ${shq(bwd)} && : forge-build=build; ${NO_PARALLEL} docker compose -p ${shq(name)} -f ${F} build --pull`, `docker compose -p ${name} build`, { timeoutMs: 45 * 60_000 });
				ctx.log('success', `Images construites en ${fmtDuration(Date.now() - tb)}.`);

				const images = built.map((x) => shq(x.image)).join(' ');
				const tr = Date.now();
				const res = await shell.pipe(
					{ t: b, user: 'root', command: `docker save ${images} | gzip -1` },
					{ t: ct(), user: 'root', command: 'gunzip | docker load' },
					{ summary: `docker save ${built.map((x) => x.image).join(' ')} → docker load`, timeoutMs: 30 * 60_000, onProgress: (n) => ctx.log('info', `  … ${formatBytes(n)} transférés`) }
				);
				if (res.from.code !== 0 || res.to.code !== 0) {
					throw new Error(`Transfert des images échoué : ${redactor.redact(`${res.from.stderr}\n${res.to.stderr}`.trim()).slice(-500)}`);
				}
				out(res.to.stdout);
				ctx.log('success', `Images transférées (${formatBytes(res.bytes)}) en ${fmtDuration(Date.now() - tr)}.`);
				// Le CT de build ne garde que son cache de couches (accélère le build suivant).
				await run(b, 'root', `: forge-build=clean; rm -rf ${shq(bdir)}; docker image rm ${images} >/dev/null 2>&1; docker builder prune -f --filter until=168h | tail -n 1`, 'Nettoyer le CT de build', { quiet: true }).catch((err) =>
					ctx.log('warn', `Nettoyage du CT de build : ${err instanceof Error ? err.message : err}`)
				);
				builtElsewhere = true;
			}
		} finally {
			markBuilderUse(-1);
		}
		if (!builtElsewhere) {
			const tb = Date.now();
			await run(ct(), 'github', `cd ${shq(wd)} && : forge-build=build; ${NO_PARALLEL} docker compose -f ${F} build --pull`, 'docker compose build (dans le CT du projet)', { timeoutMs: 45 * 60_000 });
			ctx.log('success', `Images construites dans le CT en ${fmtDuration(Date.now() - tb)}.`);
		}
	}

	// --- 4. Sauvegarde de la base, puis redémarrage sans build ----------------------------------
	if (vars.FORGE_DB_SERVICE) {
		const env = Object.entries({ ...vars, GITHUB_SHA: sha })
			.map(([k, v]) => `${k}=${shq(v)}`)
			.join(' ');
		await run(ct(), 'github', `cd ${shq(dir)} && env ${env} bash -c ${shq(workflowBackupScript(p.slug))}`, `Sauvegarde de la base « ${vars.FORGE_DB_SERVICE} » avant déploiement`, { timeoutMs: 20 * 60_000 });
	}
	await run(ct(), 'github', `cd ${shq(wd)} && : forge-build=up; docker compose -f ${F} up -d --no-build --remove-orphans`, 'docker compose up -d --no-build --remove-orphans', { timeoutMs: 10 * 60_000 });
	if (vars.FORGE_POST_DEPLOY) {
		await run(ct(), 'github', `cd ${shq(wd)} && docker compose -f ${F} exec -T ${shq(vars.FORGE_APP_SERVICE)} sh -c ${shq(vars.FORGE_POST_DEPLOY)}`, `Post-déploiement : ${vars.FORGE_POST_DEPLOY}`, { timeoutMs: 15 * 60_000 });
	}
	await run(ct(), 'github', ': forge-build=clean; docker image prune -f | tail -n 1', 'docker image prune -f (anciennes images)', { quiet: true }).catch(() => {});
	ctx.log('success', `Commit ${sha.slice(0, 7)} en ligne (${fmtDuration(Date.now() - t0)}).`);
}

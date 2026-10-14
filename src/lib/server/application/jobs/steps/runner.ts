/** Étape 2 — Runner GitHub self-hosted dans le CT. */
import type { StepDefinition } from '../types';
import { RUNNER_HOME, requireIp, shq, waitFor } from './common';

export const runnerStep: StepDefinition = {
	key: 'runner',
	label: 'Runner GitHub',
	async run(ctx) {
		const { github, shell, redactor } = ctx.services;
		const p = ctx.project();
		const ip = requireIp(ctx);
		const target = () => ({ ip, sshHostKey: ctx.project().sshHostKey });

		const runners = ctx.dryRun ? [] : await github.api.listRunners(p.repoOwner, p.repoName);
		const existing = runners.find((r) => r.name === p.slug);
		if (existing?.status === 'online') {
			ctx.recordResource('gh_runner', `${p.repoOwner}/${p.repoName}:${existing.id}`, { name: existing.name });
			ctx.log('success', `Runner « ${p.slug} » déjà enregistré et en ligne (#${existing.id}).`);
			return;
		}

		const { token } = await github.createRegistrationToken(p.repoOwner, p.repoName);
		redactor.add(token);

		const url = `https://github.com/${p.repoOwner}/${p.repoName}`;
		const config = [
			`cd ${RUNNER_HOME}`,
			`if [ -f .runner ]; then echo 'Runner déjà configuré'; else ./config.sh --unattended --url ${shq(url)} --token ${shq(token)} --name ${shq(p.slug)} --labels ${shq(`forge,${p.slug}`)} --replace; fi`
		].join(' && ');
		const out = (s: string) => s.split('\n').filter((l) => l.trim()).forEach((l) => ctx.log('debug', redactor.redact(l)));
		const r1 = await shell.run(target(), 'github', config, {
			summary: `./config.sh --unattended --url ${url} --name ${p.slug} --labels forge,${p.slug} --replace`,
			onOutput: out,
			timeoutMs: 3 * 60_000
		});
		if (r1.code !== 0) throw new Error(`config.sh a échoué (code ${r1.code}) : ${redactor.redact(r1.stderr || r1.stdout).slice(-500)}`);

		// svc.sh est lancé en root : l'utilisateur github n'a pas de sudo.
		const r2 = await shell.run(target(), 'root', `cd ${RUNNER_HOME} && (test -f .service || ./svc.sh install github) && ./svc.sh start`, {
			summary: 'svc.sh install github && svc.sh start (service systemd)',
			onOutput: out,
			timeoutMs: 2 * 60_000
		});
		if (r2.code !== 0) throw new Error(`svc.sh a échoué (code ${r2.code}) : ${(r2.stderr || r2.stdout).slice(-500)}`);

		if (ctx.dryRun) {
			ctx.log('dry', '[DRY-RUN] Vérification « runner online » simulée.');
			return;
		}
		ctx.log('info', 'Attente du runner « online » côté GitHub…');
		let runnerId = 0;
		await waitFor(
			ctx,
			async () => {
				const list = await github.api.listRunners(p.repoOwner, p.repoName);
				const r = list.find((x) => x.name === p.slug);
				if (r?.status === 'online') runnerId = r.id;
				return r?.status === 'online';
			},
			{ intervalMs: 3000, timeoutMs: 2 * 60_000, timeoutMessage: 'Le runner ne passe pas « online » sur GitHub après 2 min.' }
		);
		ctx.recordResource('gh_runner', `${p.repoOwner}/${p.repoName}:${runnerId}`, { name: p.slug });
		ctx.log('success', `Runner « ${p.slug} » en ligne (#${runnerId}), labels : self-hosted, forge, ${p.slug}.`);
	}
};

/** Étapes de maintenance : taille du CT, mise à niveau du workflow, mises à jour de sécurité. */
import { generateWorkflow, WORKFLOW_PATH, workflowVersion, WORKFLOW_VERSION } from '$lib/domain/workflow';
import type { StepDefinition } from '../types';
import { requireIp, sizeOf } from './common';

export const resizeStep: StepDefinition = {
	key: 'resize',
	label: 'Taille du CT',
	async run(ctx) {
		const { proxmox } = ctx.services;
		const p = ctx.project();
		if (!p.ctid) throw new Error('Le projet n’a pas encore de CT.');
		const size = sizeOf(p);
		// RAM et cœurs s'appliquent à chaud sur un CT LXC.
		await proxmox.configure(p.ctid, { cores: size.cores, memory: size.memoryMb, swap: size.swapMb });
		ctx.log('success', `${size.cores} cœur(s), ${size.memoryMb} Mo de RAM, ${size.swapMb} Mo de swap (appliqué à chaud).`);

		const cfg = await proxmox.guestConfig(p.ctid);
		const currentGb = Number(/size=(\d+)G/.exec(String(cfg.rootfs ?? ''))?.[1] ?? 0);
		if (currentGb && currentGb < size.diskGb) {
			const upid = await proxmox.resize(p.ctid, size.diskGb);
			if (upid) await proxmox.waitTask(upid, { timeoutMs: 5 * 60_000 });
			ctx.log('success', `Disque agrandi de ${currentGb} à ${size.diskGb} Go (à chaud).`);
		} else {
			ctx.log('info', `Disque : ${currentGb || '?'} Go, inchangé.`);
		}
	}
};

export const upgradeWorkflowStep: StepDefinition = {
	key: 'upgrade_workflow',
	label: 'Mise à niveau du workflow',
	async run(ctx) {
		const { github, repos } = ctx.services;
		const p = ctx.project();
		const id = `${p.repoOwner}/${p.repoName}:${WORKFLOW_PATH}`;
		const current = await github.api.getFile(p.repoOwner, p.repoName, WORKFLOW_PATH, p.branch);
		if (!current) throw new Error(`${WORKFLOW_PATH} est absent de ${p.branch}.`);
		const expected = generateWorkflow({ slug: p.slug, branch: p.branch, mode: p.deployMode, ctid: p.ctid });
		if (current.content === expected) {
			ctx.log('info', 'Workflow déjà à jour.');
			return;
		}
		const owned = repos.resources.findActive('gh_workflow', id);
		const recordedSha = owned ? (JSON.parse(owned.meta || '{}') as { sha?: string }).sha : undefined;
		if (!owned || recordedSha !== current.sha) {
			throw new Error(`${WORKFLOW_PATH} a été modifié en dehors de Forge : il n'est pas écrasé. Reportez les changements à la main (le nouveau contenu est dans « Mettre à niveau »).`);
		}

		if (!ctx.confirmed('workflow_update')) {
			ctx.awaitInput({
				kind: 'workflow_update',
				title: `Mettre à jour ${WORKFLOW_PATH} (v${workflowVersion(current.content) ?? '?'} → v${WORKFLOW_VERSION}) ?`,
				payload: { path: WORKFLOW_PATH, branch: p.branch, repo: `${p.repoOwner}/${p.repoName}`, before: current.content, content: expected }
			});
		}

		const res = await github.updateWorkflowFile(p.repoOwner, p.repoName, WORKFLOW_PATH, expected, p.branch, current.sha);
		if (!ctx.dryRun) repos.resources.updateMeta('gh_workflow', id, { sha: res.contentSha, commitSha: res.commitSha, branch: p.branch, version: WORKFLOW_VERSION });
		ctx.log('success', `Workflow mis à jour en v${WORKFLOW_VERSION} (${res.commitSha.slice(0, 7)}). Commit marqué [skip ci] : aucun déploiement déclenché.`);
	}
};

/** Script root : mises à jour de sécurité automatiques (dépôts « security » d'Ubuntu uniquement). */
export const OS_UPDATES_SCRIPT = [
	'export DEBIAN_FRONTEND=noninteractive',
	'apt-get update -q',
	'apt-get install -y -q unattended-upgrades',
	`printf 'APT::Periodic::Update-Package-Lists "1";\\nAPT::Periodic::Unattended-Upgrade "1";\\n' > /etc/apt/apt.conf.d/20auto-upgrades`,
	'systemctl enable --now unattended-upgrades',
	'systemctl is-enabled unattended-upgrades'
].join(' && ');

export const osUpdatesStep: StepDefinition = {
	key: 'os_updates',
	label: 'Mises à jour de sécurité',
	async run(ctx) {
		const p = ctx.project();
		const ip = requireIp(ctx);
		const res = await ctx.services.shell.run({ ip, sshHostKey: p.sshHostKey }, 'root', OS_UPDATES_SCRIPT, {
			summary: 'Activer les mises à jour de sécurité automatiques (unattended-upgrades)',
			timeoutMs: 10 * 60_000,
			onOutput: (s) => s.split('\n').filter(Boolean).forEach((l) => ctx.log('debug', l))
		});
		if (res.code !== 0) throw new Error(`apt a échoué (code ${res.code}) : ${res.stderr.trim().slice(-400)}`);
		ctx.log('success', 'Mises à jour de sécurité automatiques activées (Docker n’est pas mis à jour automatiquement, pour éviter un redémarrage surprise des conteneurs).');
	}
};

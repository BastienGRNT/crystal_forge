/** Étapes de maintenance : alimentation, retrait de domaine, suppression de projet, rollback. */
import { ExternalApiError } from '$lib/domain/errors';
import { FORGE_SECRET_NAME } from '$lib/domain/safety-policy';
import type { ResourceRow } from '$server/infrastructure/db/schema';
import type { PowerAction } from '../../ports';
import type { StepContext, StepDefinition } from '../types';

const meta = (r: ResourceRow) => {
	try {
		return JSON.parse(r.meta) as Record<string, unknown>;
	} catch {
		return {};
	}
};

/** Supprime UNE ressource créée par Forge. Toujours via les passerelles (garde + propriété). */
async function teardownResource(ctx: StepContext, r: ResourceRow): Promise<void> {
	const { proxmox, github, dns, proxy, repos } = ctx.services;
	const [repoFull, rest] = r.externalId.includes(':') ? (r.externalId.split(/:(.*)/s) as [string, string]) : [r.externalId, ''];
	const [owner, repo] = repoFull.split('/') as [string, string];

	switch (r.type) {
		case 'pve_ct': {
			const vmid = Number(r.externalId);
			const g = (await proxmox.api.guests()).find((x) => x.vmid === vmid);
			if (!g) {
				ctx.log('info', `CT ${vmid} déjà absent.`);
				break;
			}
			if (g.status === 'running') {
				await proxmox.waitTask(await proxmox.power(vmid, 'stop'), { timeoutMs: 120_000 });
				ctx.log('info', `CT ${vmid} arrêté.`);
			}
			await proxmox.waitTask(await proxmox.destroy(vmid), { timeoutMs: 5 * 60_000 });
			ctx.log('success', `CT ${vmid} supprimé.`);
			break;
		}
		case 'gh_runner': {
			await github.deleteRunner(owner, repo, Number(rest));
			ctx.log('success', `Runner #${rest} retiré de ${repoFull}.`);
			break;
		}
		case 'gh_secret':
			await github.deleteEnvSecret(owner, repo);
			ctx.log('success', `Secret ${FORGE_SECRET_NAME} supprimé de ${repoFull}.`);
			break;
		case 'gh_variable':
			await github.deleteVariable(owner, repo, rest);
			ctx.log('success', `Variable ${rest} supprimée de ${repoFull}.`);
			break;
		case 'gh_workflow': {
			const m = meta(r);
			const current = await github.api.getFile(owner, repo, rest, String(m.branch ?? 'main'));
			if (!current) {
				ctx.log('info', `${rest} déjà absent.`);
				break;
			}
			if (current.sha !== m.sha) {
				ctx.log('warn', `${rest} a été modifié depuis sa création par Forge : conservé (supprimez-le à la main si besoin).`);
				break;
			}
			await github.deleteWorkflowFile(owner, repo, rest, current.sha, String(m.branch ?? 'main'));
			ctx.log('success', `${rest} supprimé de ${repoFull}.`);
			break;
		}
		case 'npm_proxy_host':
			if (await alreadyGone(() => proxy.deleteProxyHost(Number(r.externalId)))) ctx.log('info', `Proxy host #${r.externalId} (${meta(r).fqdn ?? ''}) déjà absent de NPM.`);
			else ctx.log('success', `Proxy host #${r.externalId} (${meta(r).fqdn ?? ''}) supprimé.`);
			break;
		case 'npm_certificate':
			if (await alreadyGone(() => proxy.deleteCertificate(Number(r.externalId)))) ctx.log('info', `Certificat #${r.externalId} déjà absent de NPM.`);
			else ctx.log('success', `Certificat #${r.externalId} supprimé.`);
			break;
		case 'ovh_record': {
			const zone = repoFull;
			try {
				await dns.deleteRecord(zone, Number(rest));
				await dns.refreshZone(zone);
				ctx.log('success', `Enregistrement DNS #${rest} (${meta(r).fqdn ?? ''}) supprimé de ${zone}.`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (/403|accès refusé/.test(msg)) {
					ctx.log('warn', `Le jeton OVH n'a pas le droit DELETE : supprimez à la main l'enregistrement A ${meta(r).fqdn ?? `#${rest}`} dans ${zone}.`);
				} else throw err;
			}
			break;
		}
	}
	if (!ctx.dryRun) repos.resources.markDeleted(r.type, r.externalId);
}

/** true si NPM répond 404 : la ressource a déjà été supprimée à la main. */
async function alreadyGone(del: () => Promise<void>): Promise<boolean> {
	try {
		await del();
		return false;
	} catch (err) {
		if (err instanceof ExternalApiError && err.status === 404) return true;
		throw err;
	}
}

/** Ordre de suppression : ce qui dépend du CT d'abord, le CT en dernier. */
const TEARDOWN_ORDER: ResourceRow['type'][] = [
	'gh_workflow',
	'gh_runner',
	'gh_secret',
	'gh_variable',
	'npm_proxy_host',
	'npm_certificate',
	'ovh_record',
	'pve_ct'
];

async function teardown(ctx: StepContext, resources: ResourceRow[], types: ResourceRow['type'][]): Promise<void> {
	const errors: string[] = [];
	const list = resources
		.filter((r) => types.includes(r.type))
		.sort((a, b) => TEARDOWN_ORDER.indexOf(a.type) - TEARDOWN_ORDER.indexOf(b.type) || b.id - a.id);
	if (list.length === 0) ctx.log('info', 'Rien à supprimer.');
	for (const r of list) {
		try {
			await teardownResource(ctx, r);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(msg);
			ctx.log('error', msg);
		}
	}
	if (errors.length) throw new Error(`${errors.length} suppression(s) en échec — corrigez puis « Reprendre » (les suppressions réussies ne seront pas refaites).`);
}

export const powerStep: StepDefinition = {
	key: 'power',
	label: 'Alimentation',
	async run(ctx) {
		const p = ctx.project();
		if (!p.ctid) throw new Error('Projet sans CT.');
		const action = ctx.params.action as PowerAction;
		const upid = await ctx.services.proxmox.power(p.ctid, action);
		await ctx.services.proxmox.waitTask(upid, { timeoutMs: 3 * 60_000 });
		ctx.log('success', `Action « ${action} » terminée sur le CT ${p.ctid}.`);
	}
};

export const removeDomainStep: StepDefinition = {
	key: 'remove_domain',
	label: 'Retrait du domaine',
	async run(ctx) {
		const { repos } = ctx.services;
		const domainId = ctx.params.domainId as number;
		const d = repos.domains.get(domainId);
		if (!d) {
			ctx.log('info', 'Domaine déjà retiré.');
			return;
		}
		const res = repos.resources
			.active({ projectId: ctx.project().id })
			.filter((r) => ['npm_proxy_host', 'npm_certificate', 'ovh_record'].includes(r.type) && meta(r).fqdn === d.fqdn);
		await teardown(ctx, res, ['npm_proxy_host', 'npm_certificate', 'ovh_record']);
		if (!ctx.dryRun) repos.domains.delete(d.id);
		ctx.log('success', `${d.fqdn} retiré du projet.`);
	}
};

export const backupStep: StepDefinition = {
	key: 'backup',
	label: 'Sauvegarde vzdump',
	async run(ctx) {
		const p = ctx.project();
		if (!p.ctid || !ctx.services.repos.resources.findActive('pve_ct', String(p.ctid))) {
			ctx.log('info', 'Aucun CT Forge à sauvegarder.');
			return;
		}
		if (ctx.state.done) {
			ctx.log('info', 'Sauvegarde déjà faite (reprise).');
			return;
		}
		const upid = await ctx.services.proxmox.backup(p.ctid);
		ctx.log('info', 'Sauvegarde en cours (le CT est brièvement suspendu)…');
		await ctx.services.proxmox.waitTask(upid, { timeoutMs: 60 * 60_000, onLine: (l) => ctx.log('debug', l) });
		ctx.state.done = true;
		ctx.save();
		const last = ctx.dryRun ? null : (await ctx.services.proxmox.listBackups(p.ctid, { fresh: true }))[0];
		ctx.log('success', last ? `Sauvegarde créée : ${last.volid} (${(last.size / 1024 ** 2).toFixed(0)} Mo).` : 'Sauvegarde terminée.');
	}
};

function teardownStep(key: string, label: string, types: ResourceRow['type'][]): StepDefinition {
	return {
		key,
		label,
		async run(ctx) {
			const res = ctx.services.repos.resources.active({ projectId: ctx.project().id });
			await teardown(ctx, res, types);
		}
	};
}

export const teardownGithubStep = teardownStep('teardown_github', 'Nettoyage GitHub', ['gh_workflow', 'gh_runner', 'gh_secret', 'gh_variable']);
export const teardownProxyStep = teardownStep('teardown_proxy', 'Suppression des proxy hosts', ['npm_proxy_host', 'npm_certificate']);
export const teardownDnsStep = teardownStep('teardown_dns', 'Suppression des DNS', ['ovh_record']);
export const destroyCtStep = teardownStep('destroy_ct', 'Suppression du CT', ['pve_ct']);

/** Retire le projet de Forge (soft delete) ; les ressources encore actives sont « oubliées ». */
export function forgetProject(ctx: Pick<StepContext, 'services' | 'project' | 'dryRun' | 'log'>): void {
	const { repos } = ctx.services;
	const p = ctx.project();
	if (ctx.dryRun) {
		ctx.log('dry', `[DRY-RUN] Le projet « ${p.slug} » serait retiré de Forge.`);
		return;
	}
	for (const r of repos.resources.active({ projectId: p.id })) repos.resources.markDeleted(r.type, r.externalId);
	for (const d of repos.domains.byProject(p.id)) repos.domains.delete(d.id);
	repos.projects.update(p.id, { status: 'deleted', slug: `${p.slug}--supprime-${p.id}`, envEncrypted: null });
	ctx.log('success', `Projet « ${p.slug} » retiré de Forge.`);
}

export const finalizeStep: StepDefinition = {
	key: 'finalize',
	label: 'Retrait du projet',
	async run(ctx) {
		const remaining = ctx.services.repos.resources.active({ projectId: ctx.project().id });
		if (remaining.length && ctx.params.mode === 'forget') {
			ctx.log('info', `${remaining.length} ressource(s) externe(s) conservée(s) (CT, DNS, proxy…) : Forge ne les gérera plus.`);
		}
		forgetProject(ctx);
	}
};

export const rollbackStep: StepDefinition = {
	key: 'rollback',
	label: 'Rollback',
	async run(ctx) {
		const targetId = ctx.params.targetJobId as number;
		const res = ctx.services.repos.resources.active({ jobId: targetId });
		ctx.log('info', `${res.length} ressource(s) créée(s) par le job #${targetId} à supprimer.`);
		await teardown(ctx, res, TEARDOWN_ORDER);
		const target = ctx.services.repos.jobs.get(targetId);
		if (target?.type === 'deploy') forgetProject(ctx);
	}
};


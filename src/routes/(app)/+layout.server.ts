import { forge } from '$server/container';
import { visibleProjects } from '$server/access';
import { hostMemoryInUse } from '$lib/domain/sizes';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ depends, locals }) => {
	depends('forge:shell');
	const f = forge();
	// En différé : un Proxmox lent ou injoignable ne doit pas bloquer l'affichage des pages.
	const user = locals.user!;
	const isAdmin = user.role === 'admin';
	const host = !isAdmin ? Promise.resolve(null) : f.proxmox.nodeStatus().then(
		(n) => ({ memUsed: hostMemoryInUse(n.memory), memTotal: n.memory.total, cpu: n.cpu }),
		() => null
	);
	const projects = visibleProjects(f, user).map((p) => ({ slug: p.slug, name: p.name, status: p.status, environment: p.environment, sleeping: !!p.sleepingSince }));
	const ids = f.auth.visibleProjectIds(user);
	const active = f.repos.jobs
		.byStatus(['queued', 'running', 'awaiting_input', 'rolling_back'])
		.filter((j) => !ids || (j.projectId != null && ids.has(j.projectId)));
	return {
		user: { username: user.username, role: user.role, canCreate: f.auth.canCreateProjects(user) },
		mode: f.config.mode,
		dryRun: f.isDryRun(),
		host,
		projects,
		activeJobs: active.length,
		/** Jobs en cours, pour le menu « Activité » de la barre du haut. */
		activeJobList: active.slice(0, 8).map((j) => f.jobs.summary(j))
	};
};

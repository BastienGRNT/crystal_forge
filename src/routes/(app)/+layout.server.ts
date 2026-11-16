import { forge } from '$server/container';
import { visibleProjects } from '$server/access';
import { hostMemoryInUse } from '$lib/domain/sizes';
import { readTags } from '$lib/domain/spaces';
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
	const projects = visibleProjects(f, user).map((p) => ({ slug: p.slug, name: p.name, status: p.status, environment: p.environment, sleeping: !!p.sleepingSince, spaceId: p.spaceId, tags: readTags(p.tags) }));
	// Un collaborateur ne voit que les espaces où il a au moins un projet.
	const usedSpaces = new Set(projects.map((p) => p.spaceId));
	const spaces = f.spaces.list().filter((s) => isAdmin || usedSpaces.has(s.id));
	const seenAt = f.auth.notificationsSeenAt(user.id);
	const notes = f.notifications.list(isAdmin ? null : [...(f.auth.visibleProjectIds(user) ?? [])], 40);
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
		spaces,
		/** Cloche : dernières notifications et nombre de non lues. */
		notifications: { items: notes, unread: notes.filter((n) => n.ts > seenAt).length, seenAt },
		activeJobs: active.length,
		/** Jobs en cours, pour le menu « Activité » de la barre du haut. */
		activeJobList: active.slice(0, 8).map((j) => f.jobs.summary(j))
	};
};

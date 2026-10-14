import { forge } from '$server/container';
import { hostMemoryInUse } from '$lib/domain/sizes';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ depends }) => {
	depends('forge:shell');
	const f = forge();
	// En différé : un Proxmox lent ou injoignable ne doit pas bloquer l'affichage des pages.
	const host = f.proxmox.nodeStatus().then(
		(n) => ({ memUsed: hostMemoryInUse(n.memory), memTotal: n.memory.total, cpu: n.cpu }),
		() => null
	);
	const projects = f.repos.projects.list().map((p) => ({ slug: p.slug, name: p.name, status: p.status }));
	const activeJobs = f.repos.jobs.byStatus(['queued', 'running', 'awaiting_input', 'rolling_back']).length;
	return { mode: f.config.mode, dryRun: f.isDryRun(), host, projects, activeJobs };
};

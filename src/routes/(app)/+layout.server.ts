import { forge } from '$server/container';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ depends }) => {
	depends('forge:shell');
	const f = forge();
	let host: { memUsed: number; memTotal: number; cpu: number } | null = null;
	try {
		const n = await f.proxmox.nodeStatus();
		host = { memUsed: n.memory.used, memTotal: n.memory.total, cpu: n.cpu };
	} catch {
		host = null;
	}
	const projects = f.repos.projects.list().map((p) => ({ slug: p.slug, name: p.name, status: p.status }));
	const activeJobs = f.repos.jobs.byStatus(['queued', 'running', 'awaiting_input', 'rolling_back']).length;
	return { mode: f.config.mode, dryRun: f.isDryRun(), host, projects, activeJobs };
};

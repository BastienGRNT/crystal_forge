import { forge } from '$server/container';
import type { PageServerLoad } from './$types';

const DAY = 24 * 3600_000;

export const load: PageServerLoad = async ({ depends }) => {
	depends('forge:dashboard');
	const f = forge();
	const data = await f.dashboard.load();
	const recent = f.jobs.list({ limit: 40 });
	// Un échec ne mérite l'attention que si rien n'a réussi depuis sur le même projet (ou même type sans projet).
	const seen = new Set<string>();
	const failed = [];
	for (const j of recent) {
		const key = `${j.project?.slug ?? '-'}:${j.project ? '' : j.type}`;
		if (seen.has(key)) continue;
		if (j.status === 'succeeded' || j.status === 'failed') seen.add(key);
		if (j.status === 'failed' && Date.now() - j.createdAt < 3 * DAY) failed.push(j);
	}
	return {
		...data,
		node: f.settings.get('proxmox.node'),
		pool: f.settings.get('proxmox.pool'),
		recentJobs: recent.slice(0, 6),
		awaiting: recent.filter((j) => j.status === 'awaiting_input'),
		failed: failed.slice(0, 5)
	};
};

import { forge } from '$server/container';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const f = forge();
	const p = f.projects.get(params.slug);
	const g = p.ctid ? ((await f.proxmox.guests().catch(() => [])).find((x) => x.vmid === p.ctid) ?? null) : null;
	const running = g?.status === 'running';
	return { running, services: f.projects.containerServices(p, running) };
};

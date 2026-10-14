import { forge } from '$server/container';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ depends }) => {
	depends('forge:dashboard');
	const f = forge();
	const data = await f.dashboard.load();
	return { ...data, node: f.settings.get('proxmox.node'), pool: f.settings.get('proxmox.pool') };
};

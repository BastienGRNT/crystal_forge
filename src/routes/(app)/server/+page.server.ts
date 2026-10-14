import { fail } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, depends }) => {
	depends('forge:server');
	// Contrôles en lecture seule, chargés en différé (plusieurs appels Proxmox / NPM).
	return { report: forge().health.run(locals.clientIp ?? null) };
};

export const actions: Actions = {
	firewalls: async () => {
		const f = forge();
		try {
			const ids = await f.health.applyFirewalls((projectId) => f.engine.enqueue({ type: 'firewall', projectId, params: { forceFirewall: true } }).id);
			return { queued: ids };
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
	}
};

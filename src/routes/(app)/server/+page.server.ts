import { fail } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import { builderInfo } from '$server/application/builder';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, depends }) => {
	depends('forge:server');
	// Contrôles en lecture seule, chargés en différé (plusieurs appels Proxmox / NPM).
	const f = forge();
	const runnerProjects = f.repos.projects
		.list()
		.filter((p) => p.buildMode === 'runner' && p.ctid && p.status !== 'deleted')
		.map((p) => ({ slug: p.slug, name: p.name, status: p.status }));
	return { report: f.health.run(locals.clientIp ?? null), builder: builderInfo(f), runnerProjects };
};

export const actions: Actions = {
	migrateAll: async () => {
		try {
			return { migrated: forge().projects.migrateAllToBuilder() };
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
	},
	firewalls: async () => {
		const f = forge();
		try {
			const ids = await f.health.applyFirewalls((projectId) => f.engine.enqueue({ type: 'firewall', projectId, params: { forceFirewall: true } }).id);
			return { queued: ids };
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
	},
	maintain: async () => {
		try {
			return { maintained: await forge().health.autoMaintain() };
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
	},
	caches: async ({ request }) => {
		const f = forge();
		const slugs = (await request.formData()).getAll('slug').map(String);
		if (!slugs.length) return fail(400, { error: 'Aucun projet choisi.' });
		const ids = f.health.pruneCaches(slugs, (projectId) => f.engine.enqueue({ type: 'prune_cache', projectId }).id);
		return { pruned: ids };
	}
};

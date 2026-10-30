import { fail, redirect } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage, RamTightError, UserFacingError } from '$lib/domain/errors';
import type { DomainInput } from '$server/application/use-cases/projects';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const f = forge();
	// « Ajouter un serveur dev » depuis un projet existant : dépôt, dossier et port repris.
	const from = url.searchParams.get('from');
	const source = from ? f.repos.projects.bySlug(from) : undefined;
	const zones = await f.wizard.zones();
	return {
		zones: zones.zones,
		zonesError: zones.error,
		owner: f.settings.get('github.owner'),
		publicIp: f.settings.get('network.publicIp'),
		dryRun: f.isDryRun(),
		from: source && source.status !== 'deleted' ? { slug: source.slug, name: source.name, repo: `${source.repoOwner}/${source.repoName}`, workdir: source.workdir, appPort: source.appPort, size: source.size } : null
	};
};

export const actions: Actions = {
	default: async ({ request }) => {
		const d = await request.formData();
		const get = (k: string) => String(d.get(k) ?? '');
		let domains: DomainInput[] = [];
		try {
			domains = JSON.parse(get('domains') || '[]') as DomainInput[];
		} catch {
			return fail(400, { error: 'Domaines invalides.' });
		}
		let jobId: number;
		try {
			const res = await forge().projects.create({
				name: get('name'),
				slug: get('slug'),
				repo: get('repo'),
				workdir: get('workdir') || '.',
				appPort: Number(get('appPort')),
				size: get('size'),
				env: get('env'),
				postDeploy: get('postDeploy'),
				appService: get('appService'),
				dbService: get('dbService'),
				domains,
				acknowledgeRam: get('acknowledgeRam') === 'on',
				environment: get('environment') === 'development' ? 'development' : 'production',
				branch: get('branch')
			});
			jobId = res.jobId;
		} catch (err) {
			// L'aperçu peut avoir vu plus de RAM libre que la création : la case de confirmation doit apparaître.
			if (err instanceof RamTightError) return fail(400, { error: err.message, ramTightMb: Math.round(err.afterMb) });
			if (err instanceof UserFacingError) return fail(400, { error: err.message });
			return fail(502, { error: errorMessage(err) });
		}
		redirect(303, `/jobs/${jobId}`);
	}
};

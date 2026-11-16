import { fail, redirect } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, depends }) => {
	depends('forge:runs');
	const f = forge();
	const p = f.projects.get(params.slug);
	let runs: Awaited<ReturnType<typeof f.projects.runs>> = [];
	let runsError: string | null = null;
	try {
		runs = await f.projects.runs(p);
	} catch (err) {
		runsError = errorMessage(err);
	}
	return { runs, runsError, build: { buildMode: p.buildMode, autoDeploy: p.autoDeploy, deployedSha: p.deployedSha, branch: p.branch, hasCt: !!p.ctid }, jobs: f.jobs.list({ projectId: p.id, limit: 30 }), versions: f.jobs.deployedVersions(p.id) };
};

export const actions: Actions = {
	redeploy: async ({ params }) => {
		const f = forge();
		let id: number;
		try {
			id = f.projects.redeploy(f.projects.get(params.slug));
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		redirect(303, `/jobs/${id}`);
	},
	rollback: async ({ params, request }) => {
		const f = forge();
		const sha = String((await request.formData()).get('sha') ?? '');
		let id: number;
		try {
			const p = f.projects.get(params.slug);
			id = f.projects.rollbackTo(p, sha, f.jobs.deployedVersions(p.id, 30).map((v) => v.sha));
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		redirect(303, `/jobs/${id}`);
	},
	migrate: async ({ params }) => {
		const f = forge();
		let id: number;
		try {
			id = f.projects.migrateToBuilder(f.projects.get(params.slug));
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		redirect(303, `/jobs/${id}`);
	},
	autoDeploy: async ({ params, request }) => {
		const f = forge();
		const on = (await request.formData()).get('on') === '1';
		f.projects.setAutoDeploy(f.projects.get(params.slug), on);
		return { autoDeploySaved: true };
	}
};

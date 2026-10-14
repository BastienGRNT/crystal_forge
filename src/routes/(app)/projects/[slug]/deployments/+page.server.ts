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
	return { runs, runsError, jobs: f.jobs.list({ projectId: p.id, limit: 30 }) };
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
	}
};

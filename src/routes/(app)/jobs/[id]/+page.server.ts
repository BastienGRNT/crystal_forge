import { error, fail } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import { ADMIN_APPROVAL_KEY } from '$lib/domain/access';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const f = forge();
	const id = Number(params.id);
	const job = f.jobs.view(id);
	if (!job) error(404, 'Job introuvable');
	// Seules les dernières lignes sont affichées : un journal de plusieurs milliers de lignes fait planter la page.
	return { job, logs: f.repos.jobs.logs(id).slice(-1500), loadedAt: Date.now() };
};

function act(fn: (id: number) => unknown) {
	return async ({ params }: { params: { id: string } }) => {
		try {
			const res = fn(Number(params.id));
			return { ok: true, result: res };
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
	};
}

export const actions: Actions = {
	resume: act((id) => forge().engine.resume(id)),
	interrupt: act((id) => forge().engine.interrupt(id)),
	rollback: act((id) => ({ rollbackJobId: forge().engine.cancelWithRollback(id).id })),
	confirm: async ({ params, request, locals }) => {
		const key = String((await request.formData()).get('key') ?? '');
		// Valider un projet demandé par un collaborateur : admin seulement (le demandeur a « deploy » sur ce job).
		if (key === ADMIN_APPROVAL_KEY && locals.user?.role !== 'admin') return fail(403, { error: 'Seul un administrateur peut valider cette création.' });
		try {
			forge().engine.confirm(Number(params.id), key);
			return { ok: true };
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
	}
};

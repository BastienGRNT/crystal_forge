import { fail, redirect } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const f = forge();
	const p = f.projects.get(params.slug);
	// Le modèle (.env.example) est lu sur GitHub : chargé en différé pour ne pas bloquer la page.
	return { env: f.projects.envPreview(p), template: f.projects.envTemplateCheck(p) };
};

export const actions: Actions = {
	/** Affichage en clair du .env : seulement après re-saisie du mot de passe admin. */
	reveal: async ({ params, request }) => {
		const f = forge();
		const password = String((await request.formData()).get('password') ?? '');
		if (!(await f.auth.verifyCurrentPassword(password))) return fail(403, { revealError: 'Mot de passe incorrect.' });
		return { revealed: f.projects.revealEnv(f.projects.get(params.slug)) };
	},
	save: async ({ params, request }) => {
		const f = forge();
		const d = await request.formData();
		const redeploy = d.get('redeploy') === 'on';
		let jobId: number;
		try {
			const p = f.projects.get(params.slug);
			if (d.get('mode') === 'replace') {
				jobId = f.projects.updateEnv(p, { replace: String(d.get('env') ?? '') }, redeploy);
			} else {
				const set = JSON.parse(String(d.get('set') ?? '{}')) as Record<string, string>;
				const remove = JSON.parse(String(d.get('remove') ?? '[]')) as string[];
				jobId = f.projects.updateEnv(p, { set, remove }, redeploy);
			}
		} catch (err) {
			return fail(400, { saveError: errorMessage(err) });
		}
		redirect(303, `/jobs/${jobId}`);
	}
};

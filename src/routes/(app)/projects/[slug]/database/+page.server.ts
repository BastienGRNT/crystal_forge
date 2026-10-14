import { fail, redirect } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage, UserFacingError } from '$lib/domain/errors';
import { isSqlDbKind } from '$lib/domain/compose-analysis';
import type { Actions, PageServerLoad } from './$types';

const settle = async <T>(p: Promise<T>): Promise<{ value: T | null; error: string | null }> => {
	try {
		return { value: await p, error: null };
	} catch (err) {
		return { value: null, error: errorMessage(err) };
	}
};

export const load: PageServerLoad = async ({ params, depends }) => {
	depends('forge:database');
	const f = forge();
	const p = f.projects.get(params.slug);
	if (!p.dbService || !isSqlDbKind(p.dbKind)) {
		// Le compose (GitHub) n'est lu que pour choisir la base.
		return { configured: false as const, candidates: await settle(f.database.candidates(p)), info: null, tables: null, backups: null };
	}
	// Lectures par SSH : la page s'affiche tout de suite, elles arrivent ensuite.
	return {
		configured: true as const,
		candidates: { value: [], error: null },
		info: settle(f.database.info(p)),
		tables: settle(f.database.tables(p)),
		backups: settle(f.database.backups(p))
	};
};

export const actions: Actions = {
	configure: async ({ params, request }) => {
		const f = forge();
		const service = String((await request.formData()).get('service') ?? '').trim();
		let id: number;
		try {
			id = await f.database.configure(f.projects.get(params.slug), service || null);
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		redirect(303, `/jobs/${id}`);
	},
	query: async ({ params, request }) => {
		const f = forge();
		const d = await request.formData();
		const sql = String(d.get('sql') ?? '');
		try {
			const result = await f.database.query(f.projects.get(params.slug), sql, {
				write: d.get('write') === 'on',
				confirmDestructive: d.get('confirmDestructive') === 'on'
			});
			return { result, sql };
		} catch (err) {
			const destructive = err instanceof UserFacingError && err.message.startsWith('Opération destructrice');
			return fail(400, { queryError: errorMessage(err), sql, needsConfirm: destructive });
		}
	},
	backup: async ({ params }) => {
		const f = forge();
		let id: number;
		try {
			id = f.database.backup(f.projects.get(params.slug));
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		redirect(303, `/jobs/${id}`);
	},
	import: async ({ params, request }) => {
		const f = forge();
		const file = (await request.formData()).get('file');
		if (!(file instanceof File) || file.size === 0) return fail(400, { error: 'Choisissez un fichier .sql ou .sql.gz.' });
		try {
			const res = await f.database.importDump(f.projects.get(params.slug), { name: file.name, data: Buffer.from(await file.arrayBuffer()) });
			return { imported: res };
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
	},
	restore: async ({ params, request }) => {
		const f = forge();
		const d = await request.formData();
		let id: number;
		try {
			id = f.database.restore(f.projects.get(params.slug), String(d.get('name') ?? ''), String(d.get('confirm') ?? ''));
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		redirect(303, `/jobs/${id}`);
	}
};

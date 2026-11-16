import { json } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage } from '$lib/domain/errors';
import type { RequestHandler } from './$types';

/** Commits poussés sur la branche mais pas encore en ligne (lecture GitHub). */
export const GET: RequestHandler = async ({ params }) => {
	const f = forge();
	try {
		const p = f.projects.get(params.slug);
		if (!p.deployedSha) return json({ known: false, aheadBy: 0, commits: [] });
		const head = await f.github.api.latestCommit(p.repoOwner, p.repoName, p.branch);
		if (head.sha === p.deployedSha) return json({ known: true, aheadBy: 0, commits: [], head: head.sha });
		const cmp = await f.github.api.compareCommits(p.repoOwner, p.repoName, p.deployedSha, head.sha);
		return json({ known: true, aheadBy: cmp.aheadBy, commits: cmp.commits.slice(0, 10), head: head.sha });
	} catch (err) {
		return json({ error: errorMessage(err) }, { status: 400 });
	}
};

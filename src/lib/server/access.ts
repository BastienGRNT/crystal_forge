/** Ce qu'un utilisateur a le droit de voir : l'admin voit tout, un collaborateur ses projets assignés. */
import type { Forge } from './container';
import type { SessionUser } from './application/use-cases/auth';
import type { ProjectRow } from './infrastructure/db/schema';

export function visibleProjects(f: Forge, user: SessionUser): ProjectRow[] {
	const ids = f.auth.visibleProjectIds(user);
	const all = f.repos.projects.list();
	return ids ? all.filter((p) => ids.has(p.id)) : all;
}

/** Filtre de jobs : undefined = tous (admin). */
export function visibleProjectIdList(f: Forge, user: SessionUser): number[] | undefined {
	const ids = f.auth.visibleProjectIds(user);
	return ids ? [...ids] : undefined;
}

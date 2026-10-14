import type { ProjectRow } from '$server/infrastructure/db/schema';

/** Projet sans aucun champ sensible, envoyable au navigateur. */
export function publicProject(p: ProjectRow) {
	const { envEncrypted, ...rest } = p;
	return { ...rest, hasEnv: !!envEncrypted };
}

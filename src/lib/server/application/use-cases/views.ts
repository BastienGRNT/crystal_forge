import type { ProjectRow } from '$server/infrastructure/db/schema';

/** Projet sans aucun champ sensible, envoyable au navigateur. */
export function publicProject(p: ProjectRow) {
	const { envEncrypted: _env, sshHostKey, ...rest } = p;
	return { ...rest, hasEnv: !!_env, sshHostKey };
}

export type PublicProject = ReturnType<typeof publicProject>;

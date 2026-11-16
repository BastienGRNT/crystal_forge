/**
 * Console web d'un conteneur (admin). Pas de vrai terminal : chaque commande est envoyée seule
 * par SSH, et Forge retient le dossier courant entre deux commandes.
 */

export const CONSOLE_MARK = '__FORGE_CONSOLE__';
export const CONSOLE_MAX_COMMAND = 2000;
export const CONSOLE_MAX_OUTPUT = 200_000;
export const CONSOLE_TIMEOUT_MS = 60_000;

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Dossier courant accepté : chemin absolu simple, sans saut de ligne. */
export function isConsoleCwd(cwd: string): boolean {
	return cwd.startsWith('/') && cwd.length <= 512 && !/[\n\r\0]/.test(cwd);
}

/** Commande valide : une ligne, non vide, bornée. */
export function validateConsoleCommand(command: string): string | null {
	const c = command.trim();
	if (!c) return 'Commande vide.';
	if (c.length > CONSOLE_MAX_COMMAND) return 'Commande trop longue.';
	if (/[\n\r\0]/.test(c)) return 'Une seule ligne à la fois.';
	return null;
}

/** Commande réellement exécutée : se place dans le dossier, lance, puis renvoie le code et le nouveau dossier. */
export function consoleScript(cwd: string, command: string): string {
	const dir = isConsoleCwd(cwd) ? cwd : '/root';
	return `cd ${shq(dir)} 2>/dev/null || cd /root; ${command.trim()}
__rc=$?; printf '\\n${CONSOLE_MARK}%s:%s\\n' "$__rc" "$(pwd)"`;
}

/** Sépare la sortie de la commande du marqueur ajouté par consoleScript. */
export function parseConsoleOutput(stdout: string, fallbackCwd: string): { output: string; code: number | null; cwd: string } {
	const i = stdout.lastIndexOf(`\n${CONSOLE_MARK}`);
	if (i < 0) return { output: stdout, code: null, cwd: fallbackCwd };
	const m = /^(\d+):(.*)$/.exec(stdout.slice(i + 1 + CONSOLE_MARK.length).trim());
	const cwd = m && isConsoleCwd(m[2]!) ? m[2]! : fallbackCwd;
	return { output: stdout.slice(0, i), code: m ? Number(m[1]) : null, cwd };
}

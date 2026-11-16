/**
 * Client restic (binaire installé dans l'image de Forge). Le dépôt est chiffré par restic
 * avec le mot de passe fourni ; les identifiants S3 et le mot de passe passent par
 * l'environnement du processus, jamais par la ligne de commande.
 */
import { spawn } from 'node:child_process';
import type { OffsiteApi } from '$server/application/ports';
import { resticRepository, type OffsiteConfig } from '$lib/domain/offsite';

const TIMEOUT_MS = 60 * 60_000;

export class ResticClient implements OffsiteApi {
	readonly #env: NodeJS.ProcessEnv;

	constructor(c: OffsiteConfig) {
		this.#env = {
			PATH: process.env.PATH,
			HOME: process.env.HOME ?? '/tmp',
			RESTIC_REPOSITORY: resticRepository(c),
			RESTIC_PASSWORD: c.password,
			AWS_ACCESS_KEY_ID: c.accessKeyId,
			AWS_SECRET_ACCESS_KEY: c.secretAccessKey,
			// R2 accepte la région « auto ».
			AWS_DEFAULT_REGION: 'auto',
			RESTIC_CACHE_DIR: process.env.RESTIC_CACHE_DIR ?? '/data/restic-cache'
		};
	}

	#run(args: string[], opts: { stdin?: Buffer; maxBytes?: number } = {}): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const child = spawn('restic', args, { env: this.#env, stdio: ['pipe', 'pipe', 'pipe'] });
			const out: Buffer[] = [];
			let size = 0;
			let err = '';
			const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
			child.stdout.on('data', (b: Buffer) => {
				size += b.length;
				if (opts.maxBytes && size > opts.maxBytes) {
					child.kill('SIGTERM');
					return reject(new Error(`Fichier trop gros (> ${Math.round(opts.maxBytes / 1024 ** 2)} Mo).`));
				}
				out.push(b);
			});
			child.stderr.on('data', (b: Buffer) => (err = (err + b.toString()).slice(-4000)));
			child.on('error', (e) => {
				clearTimeout(timer);
				reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('restic absent de l’image de Forge : mettez Forge à jour.') : e);
			});
			child.on('close', (code) => {
				clearTimeout(timer);
				if (code === 0) resolve(Buffer.concat(out));
				else reject(new Error(`restic ${args[0]} : ${err.trim().split('\n').slice(-3).join(' ') || `code ${code}`}`));
			});
			child.stdin.on('error', () => {});
			child.stdin.end(opts.stdin ?? undefined);
		});
	}

	async initialized(): Promise<boolean> {
		try {
			await this.#run(['cat', 'config']);
			return true;
		} catch {
			return false;
		}
	}
	async init(): Promise<void> {
		await this.#run(['init']);
	}
	async backup(path: string, data: Buffer, tags: string[]): Promise<void> {
		await this.#run(['backup', '--stdin', '--stdin-filename', path.replace(/^\//, ''), ...tags.flatMap((t) => ['--tag', t])], { stdin: data });
	}
	async snapshotsJson(): Promise<string> {
		return (await this.#run(['snapshots', '--json'])).toString('utf8');
	}
	dump(snapshotId: string, path: string, maxBytes: number): Promise<Buffer> {
		return this.#run(['dump', snapshotId, path], { maxBytes });
	}
	async forget(args: string[]): Promise<void> {
		await this.#run(['forget', ...args]);
	}
}

/**
 * SSH (ssh2) vers les CT Forge, avec vérification TOFU de la clé d'hôte :
 * la première connexion enregistre l'empreinte, les suivantes l'exigent.
 */
import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import { ExternalApiError } from '$lib/domain/errors';
import type { SshApi, SshResult, SshTarget } from '$server/application/ports';

export function fingerprint(key: Buffer): string {
	return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

/** Génère la paire de clés ed25519 de Forge (format OpenSSH). */
export function generateForgeKeyPair(comment = 'forge'): { privateKey: string; publicKey: string } {
	const kp = ssh2.utils.generateKeyPairSync('ed25519', { comment });
	return { privateKey: kp.private, publicKey: kp.public.trim() };
}

export function publicKeyFingerprint(publicKey: string): string | null {
	const parts = publicKey.trim().split(/\s+/);
	if (parts.length < 2 || !parts[1]) return null;
	return fingerprint(Buffer.from(parts[1], 'base64'));
}

/** Connexion gardée ouverte entre deux commandes vers le même CT. */
interface PooledConnection {
	conn: ssh2.Client;
	/** Résout l'empreinte de la clé d'hôte une fois la connexion prête. */
	ready: Promise<string>;
	active: number;
	idleTimer: ReturnType<typeof setTimeout> | null;
	closed: boolean;
}

/** Fermée après ce délai sans commande. */
const IDLE_MS = 30_000;
/** OpenSSH accepte 10 sessions par connexion (MaxSessions) : on reste en dessous. */
const MAX_CHANNELS = 8;

export class SshClient implements SshApi {
	readonly #pool = new Map<string, PooledConnection>();

	exec(target: SshTarget, command: string, opts: { timeoutMs?: number; onOutput?: (chunk: string) => void; stdin?: Buffer } = {}): Promise<SshResult> {
		return this.#execOnce(target, command, opts, true);
	}

	async #execOnce(target: SshTarget, command: string, opts: { timeoutMs?: number; onOutput?: (chunk: string) => void; stdin?: Buffer }, retry: boolean): Promise<SshResult> {
		const { pooled, reused } = this.#acquire(target);
		try {
			const hostKey = await pooled.ready;
			return await this.#run(pooled, target, hostKey, command, opts);
		} catch (err) {
			// Connexion réutilisée fermée entre-temps (CT redémarré, sshd relancé) : une seule nouvelle tentative.
			if (retry && reused && err instanceof ChannelOpenError) {
				this.#evict(target, pooled);
				return this.#execOnce(target, command, opts, false);
			}
			throw err;
		} finally {
			this.#release(target, pooled);
		}
	}

	#key(t: SshTarget): string {
		const keyHash = createHash('sha256').update(t.privateKey).digest('hex').slice(0, 16);
		return `${t.user}@${t.host}:${t.port ?? 22}|${t.expectedHostKey ?? ''}|${keyHash}`;
	}

	#acquire(target: SshTarget): { pooled: PooledConnection; reused: boolean } {
		const key = this.#key(target);
		const existing = this.#pool.get(key);
		if (existing && !existing.closed && existing.active < MAX_CHANNELS) {
			existing.active++;
			if (existing.idleTimer) clearTimeout(existing.idleTimer);
			existing.idleTimer = null;
			return { pooled: existing, reused: true };
		}
		const pooled = this.#connect(target);
		pooled.active = 1;
		// Une connexion pleine reste utilisée par ses commandes en cours ; la nouvelle prend sa place.
		this.#pool.set(key, pooled);
		return { pooled, reused: false };
	}

	#release(target: SshTarget, pooled: PooledConnection) {
		pooled.active--;
		if (pooled.active > 0 || pooled.closed) return;
		if (this.#pool.get(this.#key(target)) !== pooled) {
			pooled.conn.end();
			return;
		}
		pooled.idleTimer = setTimeout(() => this.#evict(target, pooled), IDLE_MS);
		pooled.idleTimer.unref();
	}

	#evict(target: SshTarget, pooled: PooledConnection) {
		pooled.closed = true;
		if (pooled.idleTimer) clearTimeout(pooled.idleTimer);
		const key = this.#key(target);
		if (this.#pool.get(key) === pooled) this.#pool.delete(key);
		pooled.conn.end();
	}

	#connect(target: SshTarget): PooledConnection {
		const conn = new ssh2.Client();
		const pooled: PooledConnection = { conn, ready: Promise.resolve(''), active: 0, idleTimer: null, closed: false };
		pooled.ready = new Promise<string>((resolve, reject) => {
			let hostKey = '';
			const fail = (err: ExternalApiError) => {
				this.#evict(target, pooled);
				reject(err);
			};
			conn
				.on('ready', () => resolve(hostKey))
				.on('error', (err) => fail(new ExternalApiError('SSH', `${target.user}@${target.host} : ${err.message}`)))
				.on('close', () => {
					pooled.closed = true;
					const key = this.#key(target);
					if (this.#pool.get(key) === pooled) this.#pool.delete(key);
					reject(new ExternalApiError('SSH', `${target.user}@${target.host} : connexion fermée`));
				})
				.connect({
					host: target.host,
					port: target.port ?? 22,
					username: target.user,
					privateKey: target.privateKey,
					readyTimeout: 15_000,
					// Détecte une connexion morte gardée dans le pool.
					keepaliveInterval: 10_000,
					keepaliveCountMax: 2,
					hostVerifier: (key: Buffer) => {
						hostKey = fingerprint(key);
						if (target.expectedHostKey && target.expectedHostKey !== hostKey) {
							fail(
								new ExternalApiError(
									'SSH',
									`la clé d'hôte de ${target.host} a changé (attendue ${target.expectedHostKey}, reçue ${hostKey}) : connexion refusée`
								)
							);
							return false;
						}
						return true;
					}
				});
		});
		// Évite un rejet non géré si personne n'attend encore la connexion.
		pooled.ready.catch(() => {});
		return pooled;
	}

	#run(pooled: PooledConnection, target: SshTarget, hostKey: string, command: string, opts: { timeoutMs?: number; onOutput?: (chunk: string) => void; stdin?: Buffer }): Promise<SshResult> {
		return new Promise((resolve, reject) => {
			let stdout = '';
			let stderr = '';
			let settled = false;
			let channel: ssh2.ClientChannel | null = null;
			const onConnClose = () => finish(() => reject(new ExternalApiError('SSH', `${target.user}@${target.host} : connexion perdue pendant la commande`)));
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				pooled.conn.off('close', onConnClose);
				fn();
			};
			const timer = setTimeout(() => {
				channel?.close();
				finish(() => reject(new ExternalApiError('SSH', `délai dépassé sur ${target.user}@${target.host}`)));
			}, opts.timeoutMs ?? 120_000);
			pooled.conn.once('close', onConnClose);

			const onChannel = (err: Error | undefined, stream: ssh2.ClientChannel) => {
				if (err) return finish(() => reject(new ChannelOpenError(err.message)));
				channel = stream;
				stream
					.on('close', (code: number | null, signal?: string) => {
						// Sans code de sortie (signal, connexion coupée), la commande n'a PAS réussi.
						if (code === null || code === undefined) {
							finish(() => reject(new ExternalApiError('SSH', `commande interrompue sur ${target.host}${signal ? ` (signal ${signal})` : ''}`)));
						} else finish(() => resolve({ code, stdout, stderr, hostKey }));
					})
					.on('data', (d: Buffer) => {
						const s = d.toString('utf8');
						stdout += s;
						opts.onOutput?.(s);
					});
				stream.stderr.on('data', (d: Buffer) => {
					const s = d.toString('utf8');
					stderr += s;
					opts.onOutput?.(s);
				});
				// Entrée standard (fichier importé) : envoyée puis fermée.
				if (opts.stdin) stream.end(opts.stdin);
			};
			try {
				pooled.conn.exec(command, onChannel);
			} catch (err) {
				// « Not connected » : la connexion du pool vient de se fermer.
				finish(() => reject(new ChannelOpenError(err instanceof Error ? err.message : String(err))));
			}
		});
	}
}

/** Ouverture de canal refusée : la connexion du pool n'est plus utilisable. */
class ChannelOpenError extends ExternalApiError {
	constructor(message: string) {
		super('SSH', message);
	}
}

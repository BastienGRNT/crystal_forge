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

export class SshClient implements SshApi {
	exec(target: SshTarget, command: string, opts: { timeoutMs?: number; onOutput?: (chunk: string) => void; stdin?: Buffer } = {}): Promise<SshResult> {
		return new Promise((resolve, reject) => {
			const conn = new ssh2.Client();
			let hostKey = '';
			let stdout = '';
			let stderr = '';
			let settled = false;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				conn.end();
				fn();
			};
			const timer = setTimeout(
				() => finish(() => reject(new ExternalApiError('SSH', `délai dépassé sur ${target.user}@${target.host}`))),
				opts.timeoutMs ?? 120_000
			);

			conn
				.on('ready', () => {
					conn.exec(command, (err, stream) => {
						if (err) return finish(() => reject(new ExternalApiError('SSH', err.message)));
						stream
							.on('close', (code: number | null) => finish(() => resolve({ code: code ?? 0, stdout, stderr, hostKey })))
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
					});
				})
				.on('error', (err) => finish(() => reject(new ExternalApiError('SSH', `${target.user}@${target.host} : ${err.message}`))))
				.connect({
					host: target.host,
					port: 22,
					username: target.user,
					privateKey: target.privateKey,
					readyTimeout: 15_000,
					hostVerifier: (key: Buffer) => {
						hostKey = fingerprint(key);
						if (target.expectedHostKey && target.expectedHostKey !== hostKey) {
							finish(() =>
								reject(
									new ExternalApiError(
										'SSH',
										`la clé d'hôte de ${target.host} a changé (attendue ${target.expectedHostKey}, reçue ${hostKey}) : connexion refusée`
									)
								)
							);
							return false;
						}
						return true;
					}
				});
		});
	}
}

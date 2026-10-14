import { Agent, fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit } from 'undici';
import { ExternalApiError } from '$lib/domain/errors';

export interface HttpOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	timeoutMs?: number;
	dispatcher?: Dispatcher;
}

export interface HttpResponse {
	status: number;
	statusText: string;
	headers: Headers;
	text: string;
}

export async function httpRequest(system: string, url: string, opts: HttpOptions = {}): Promise<HttpResponse> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
	try {
		const init: UndiciRequestInit = {
			method: opts.method ?? 'GET',
			headers: opts.headers,
			body: opts.body,
			signal: controller.signal,
			dispatcher: opts.dispatcher
		};
		const res = await undiciFetch(url, init);
		const text = await res.text();
		return { status: res.status, statusText: res.statusText, headers: res.headers as unknown as Headers, text };
	} catch (err) {
		const cause = err instanceof Error ? ((err as Error & { cause?: { code?: string; message?: string } }).cause ?? err) : err;
		const detail = (cause as { code?: string; message?: string })?.code ?? (cause as Error)?.message ?? String(cause);
		if (controller.signal.aborted) throw new ExternalApiError(system, `délai dépassé (${url})`);
		throw new ExternalApiError(system, `connexion impossible à ${new URL(url).host} : ${detail}`);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Dispatcher TLS pour Proxmox : si le CA de Proxmox (pve-root-ca.pem) est fourni,
 * la chaîne de certificats est vérifiée, mais pas le nom d'hôte : pve-ssl.pem ne contient
 * pas 10.10.10.1 dans ses SAN (seulement l'IP publique, le nom du nœud et localhost).
 * Sans CA : vérification désactivée (signalé dans « Tester les connexions »).
 */
export function proxmoxDispatcher(caPem: string): Agent {
	const ca = caPem.trim();
	return new Agent({
		connect: ca
			? { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined }
			: { rejectUnauthorized: false }
	});
}

const TLS_ERRORS = /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER_CERT|CERT_SIGNATURE_FAILURE|CERT_UNTRUSTED|ERR_TLS_CERT/;

export function isTlsError(message: string): boolean {
	return TLS_ERRORS.test(message);
}

export function parseJson<T>(system: string, text: string): T {
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new ExternalApiError(system, `réponse non JSON : ${text.slice(0, 200)}`);
	}
}

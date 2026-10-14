/**
 * Client API Nginx Proxy Manager (schéma OpenAPI de NPM 2.16, backend/schema).
 * Authentification : POST /api/tokens {identity, secret} → JWT Bearer.
 * NPM n'a pas de permission « ajout seulement » : la règle est appliquée par ProxyGateway.
 */
import { ExternalApiError } from '$lib/domain/errors';
import type { NpmApi, NpmCertificate, NpmCreateProxyHost, NpmProxyHost, NpmUser } from '$server/application/ports';
import { httpRequest, parseJson } from './http';

export interface NpmConfig {
	url: string; // ex. http://10.10.10.2:81
	identity: string;
	secret: string;
}

interface RawHost {
	id: number;
	domain_names: string[];
	forward_scheme: string;
	forward_host: string;
	forward_port: number;
	certificate_id: number;
	ssl_forced: boolean | number;
	enabled: boolean | number;
	meta?: { nginx_online?: boolean; nginx_err?: string | null };
	certificate?: { id: number; expires_on?: string | null; provider?: string } | null;
}

function toHost(h: RawHost): NpmProxyHost {
	return {
		id: h.id,
		domainNames: h.domain_names ?? [],
		forwardScheme: h.forward_scheme,
		forwardHost: h.forward_host,
		forwardPort: h.forward_port,
		certificateId: h.certificate_id ?? 0,
		sslForced: !!h.ssl_forced,
		enabled: !!h.enabled,
		nginxOnline: h.meta?.nginx_online ?? null,
		nginxError: h.meta?.nginx_err ?? null,
		certificate: h.certificate ? { id: h.certificate.id, expiresOn: h.certificate.expires_on ?? null, provider: h.certificate.provider ?? '' } : null
	};
}

export class NpmClient implements NpmApi {
	#token: { value: string; expiresAt: number } | null = null;

	constructor(private readonly cfg: NpmConfig) {}

	get #base() {
		return this.cfg.url.replace(/\/+$/, '') + '/api';
	}

	async #auth(): Promise<string> {
		if (this.#token && this.#token.expiresAt - 60_000 > Date.now()) return this.#token.value;
		if (!this.cfg.identity || !this.cfg.secret) throw new ExternalApiError('NPM', 'identifiants non configurés (Réglages → NPM)');
		const res = await httpRequest('NPM', `${this.#base}/tokens`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ identity: this.cfg.identity, secret: this.cfg.secret })
		});
		if (res.status >= 400) throw new ExternalApiError('NPM', `connexion refusée (HTTP ${res.status}) : identifiant ou mot de passe incorrect`, res.status);
		const data = parseJson<{ token?: string; expires?: string; requires_2fa?: boolean }>('NPM', res.text);
		if (data.requires_2fa) {
			throw new ExternalApiError('NPM', 'le compte NPM dédié a la double authentification activée : désactivez-la pour ce compte');
		}
		if (!data.token) throw new ExternalApiError('NPM', 'réponse /api/tokens sans jeton');
		this.#token = { value: data.token, expiresAt: data.expires ? Date.parse(data.expires) : Date.now() + 3600_000 };
		return data.token;
	}

	async #call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
		const token = await this.#auth();
		const res = await httpRequest('NPM', `${this.#base}${path}`, {
			method,
			timeoutMs,
			headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
			body: body ? JSON.stringify(body) : undefined
		});
		if (res.status >= 400) {
			let msg = res.text.slice(0, 300);
			try {
				const j = JSON.parse(res.text) as { error?: { message?: string } };
				msg = j.error?.message ?? msg;
			} catch {
				/* non JSON */
			}
			if (res.status === 401) this.#token = null;
			throw new ExternalApiError('NPM', `${method} ${path} : HTTP ${res.status} ${msg}`, res.status);
		}
		return res.text ? parseJson<T>('NPM', res.text) : (null as T);
	}

	async health() {
		const res = await httpRequest('NPM', `${this.#base}/`);
		const j = parseJson<{ status: string; version?: { major: number; minor: number; revision: number } }>('NPM', res.text);
		const v = j.version ? `${j.version.major}.${j.version.minor}.${j.version.revision}` : 'inconnue';
		return { status: j.status, version: v };
	}

	async me(): Promise<NpmUser> {
		const u = await this.#call<{ id: number; email: string; name: string; roles?: string[]; permissions?: Record<string, string> | null }>(
			'GET',
			'/users/me?expand=permissions'
		);
		return { id: u.id, email: u.email, name: u.name, roles: u.roles ?? [], permissions: u.permissions ?? null };
	}

	async listProxyHosts() {
		return (await this.#call<RawHost[]>('GET', '/nginx/proxy-hosts?expand=certificate')).map(toHost);
	}

	async listCertificates(): Promise<NpmCertificate[]> {
		const rows = await this.#call<{ id: number; nice_name: string; domain_names: string[]; expires_on?: string | null; provider: string }[]>(
			'GET',
			'/nginx/certificates'
		);
		return rows.map((c) => ({ id: c.id, niceName: c.nice_name, domainNames: c.domain_names, expiresOn: c.expires_on ?? null, provider: c.provider }));
	}

	async createProxyHost(payload: NpmCreateProxyHost) {
		// La demande de certificat Let's Encrypt est faite dans la même requête : délai long.
		return toHost(await this.#call<RawHost>('POST', '/nginx/proxy-hosts', payload, 180_000));
	}

	async deleteProxyHost(id: number) {
		await this.#call('DELETE', `/nginx/proxy-hosts/${id}`);
	}

	async deleteCertificate(id: number) {
		await this.#call('DELETE', `/nginx/certificates/${id}`);
	}
}

/**
 * Client API Nginx Proxy Manager (schéma OpenAPI de NPM 2.16, backend/schema).
 * Authentification : POST /api/tokens {identity, secret} → JWT Bearer.
 * NPM n'a pas de permission « ajout seulement » : la règle est appliquée par ProxyGateway.
 */
import { ExternalApiError } from '$lib/domain/errors';
import type { NpmApi, NpmCertificate, NpmCreateProxyHost, NpmProxyHost, NpmUser, OvhDnsCredentials } from '$server/application/ports';
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
	access_list_id?: number;
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
		accessListId: h.access_list_id ?? 0,
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

	async #call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
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
		const u = await this.#call<{ id: number; email: string; name: string; roles?: string[]; permissions?: Record<string, string> | null }>('GET', '/users/me?expand=permissions');
		return { id: u.id, email: u.email, name: u.name, roles: u.roles ?? [], permissions: u.permissions ?? null };
	}

	async listProxyHosts() {
		return (await this.#call<RawHost[]>('GET', '/nginx/proxy-hosts?expand=certificate')).map(toHost);
	}

	async listCertificates(): Promise<NpmCertificate[]> {
		const rows = await this.#call<{ id: number; nice_name: string; domain_names: string[]; expires_on?: string | null; provider: string }[]>('GET', '/nginx/certificates');
		return rows.map((c) => ({ id: c.id, niceName: c.nice_name, domainNames: c.domain_names, expiresOn: c.expires_on ?? null, provider: c.provider }));
	}

	async createProxyHost(payload: NpmCreateProxyHost) {
		// La demande de certificat Let's Encrypt est faite dans la même requête : délai long.
		return toHost(await this.#call<RawHost>('POST', '/nginx/proxy-hosts', payload, 180_000));
	}

	async updateProxyHost(id: number, patch: { forward_host: string; forward_port: number }) {
		return toHost(await this.#call<RawHost>('PUT', `/nginx/proxy-hosts/${id}`, patch));
	}

	async setProxyHostAccessList(id: number, accessListId: number) {
		return toHost(await this.#call<RawHost>('PUT', `/nginx/proxy-hosts/${id}`, { access_list_id: accessListId }));
	}

	async deleteProxyHost(id: number) {
		await this.#call('DELETE', `/nginx/proxy-hosts/${id}`);
	}

	async deleteCertificate(id: number) {
		await this.#call('DELETE', `/nginx/certificates/${id}`);
	}

	async createDnsCertificate(input: { domain: string; email: string; ovh: OvhDnsCredentials }) {
		const endpoint = /\/\/ca\./.test(input.ovh.endpoint) ? 'ovh-ca' : /us\./.test(input.ovh.endpoint) ? 'ovh-us' : 'ovh-eu';
		const credentials = [
			`dns_ovh_endpoint = ${endpoint}`,
			`dns_ovh_application_key = ${input.ovh.appKey}`,
			`dns_ovh_application_secret = ${input.ovh.appSecret}`,
			`dns_ovh_consumer_key = ${input.ovh.consumerKey}`
		].join('\n');
		// Les champs de « meta » acceptés varient selon la version de NPM (additionalProperties: false) :
		// on ne garde que ceux que le schéma de CETTE instance déclare.
		const allowed = await this.#certificateMetaKeys();
		const wanted: Record<string, unknown> = {
			letsencrypt_email: input.email,
			letsencrypt_agree: true,
			dns_challenge: true,
			dns_provider: 'ovh',
			dns_provider_credentials: credentials,
			propagation_seconds: 60
		};
		const meta = Object.fromEntries(Object.entries(wanted).filter(([k]) => !allowed || allowed.has(k)));
		const body = { provider: 'letsencrypt', domain_names: [input.domain], meta };
		// Challenge DNS + propagation : plusieurs minutes possibles.
		const r = await this.#call<{ id: number; nice_name?: string; domain_names: string[]; expires_on?: string | null; provider?: string }>(
			'POST',
			'/nginx/certificates',
			body,
			360_000
		);
		return {
			id: r.id,
			niceName: r.nice_name ?? input.domain,
			domainNames: r.domain_names ?? [input.domain],
			expiresOn: r.expires_on ?? null,
			provider: r.provider ?? 'letsencrypt'
		};
	}

	/** Propriétés de « meta » déclarées par le schéma OpenAPI de NPM, ou null si illisible. */
	async #certificateMetaKeys(): Promise<Set<string> | null> {
		try {
			const schema = await this.#call<Record<string, unknown>>('GET', '/schema');
			const resolve = (n: unknown): Record<string, unknown> | undefined => {
				let node = n as Record<string, unknown> | undefined;
				for (let i = 0; i < 10 && node && typeof node.$ref === 'string'; i++) {
					node = (node.$ref as string)
						.replace(/^#\//, '')
						.split('/')
						.reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], schema) as Record<string, unknown> | undefined;
				}
				return node;
			};
			const paths = schema.paths as Record<string, Record<string, unknown>> | undefined;
			const post = resolve(paths?.['/nginx/certificates']?.post) as { requestBody?: unknown } | undefined;
			const content = resolve(post?.requestBody) as { content?: Record<string, { schema?: unknown }> } | undefined;
			const body = resolve(content?.content?.['application/json']?.schema) as { properties?: Record<string, unknown> } | undefined;
			const meta = resolve(body?.properties?.meta) as { properties?: Record<string, unknown> } | undefined;
			const keys = meta?.properties ? Object.keys(meta.properties) : [];
			return keys.length ? new Set(keys) : null;
		} catch {
			return null;
		}
	}

	async createAccessList(name: string, username: string, password: string) {
		// satisfy_any: sans règle d'IP, NPM ajoute un « deny all » : avec « satisfy all » le mot de passe ne suffit pas (403 partout).
		const r = await this.#call<{ id: number }>('POST', '/nginx/access-lists', { name, satisfy_any: true, pass_auth: false, items: [{ username, password }], clients: [] });
		return { id: r.id };
	}

	async allowPasswordOnly(id: number, name: string) {
		// Sans « items » : NPM garde l'utilisateur et son mot de passe.
		await this.#call('PUT', `/nginx/access-lists/${id}`, { name, satisfy_any: true, pass_auth: false });
	}

	async listAccessListUsers(id: number) {
		const r = await this.#call<{ items?: { username: string }[] }>('GET', `/nginx/access-lists/${id}?expand=items`);
		return (r.items ?? []).map((i) => i.username);
	}

	async setAccessListUsers(id: number, name: string, users: { username: string; password?: string }[]) {
		const items = users.map((u) => (u.password ? { username: u.username, password: u.password } : { username: u.username }));
		await this.#call('PUT', `/nginx/access-lists/${id}`, { name, satisfy_any: true, pass_auth: false, items });
	}

	async deleteAccessList(id: number) {
		await this.#call('DELETE', `/nginx/access-lists/${id}`);
	}
}

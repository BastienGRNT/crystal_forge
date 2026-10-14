/**
 * Client API OVH v1 (signature faite à la main, voir ovh-signature.ts).
 * Toujours utilisé derrière DnsGateway : uniquement des enregistrements A, création
 * seulement si le nom est libre, suppression seulement de ce que Forge a créé.
 */
import { ExternalApiError } from '$lib/domain/errors';
import type { OvhApi, OvhCredential, OvhRecord } from '$server/application/ports';
import { httpRequest, parseJson } from './http';
import { ovhSignature } from './ovh-signature';

export interface OvhConfig {
	endpoint: string; // ex. https://eu.api.ovh.com/1.0
	appKey: string;
	appSecret: string;
	consumerKey: string;
}

export class OvhClient implements OvhApi {
	#timeDelta: number | null = null;

	constructor(private readonly cfg: OvhConfig) {
		if (!cfg.appKey || !cfg.appSecret || !cfg.consumerKey) {
			throw new ExternalApiError('OVH', 'clés API non configurées (Réglages → OVH)');
		}
	}

	get #base() {
		return this.cfg.endpoint.replace(/\/+$/, '');
	}

	async #time(): Promise<number> {
		if (this.#timeDelta === null) {
			const res = await httpRequest('OVH', `${this.#base}/auth/time`);
			const server = Number(res.text.trim());
			this.#timeDelta = Number.isFinite(server) ? server - Math.floor(Date.now() / 1000) : 0;
		}
		return Math.floor(Date.now() / 1000) + this.#timeDelta;
	}

	async #call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
		const qs = opts.query ? new URLSearchParams(opts.query).toString() : '';
		const url = `${this.#base}${path}${qs ? `?${qs}` : ''}`;
		const body = opts.body === undefined ? '' : JSON.stringify(opts.body);
		const timestamp = await this.#time();
		const res = await httpRequest('OVH', url, {
			method,
			body: body || undefined,
			headers: {
				'Content-Type': 'application/json',
				'X-Ovh-Application': this.cfg.appKey,
				'X-Ovh-Consumer': this.cfg.consumerKey,
				'X-Ovh-Timestamp': String(timestamp),
				'X-Ovh-Signature': ovhSignature({ appSecret: this.cfg.appSecret, consumerKey: this.cfg.consumerKey, method, url, body, timestamp })
			}
		});
		if (res.status >= 400) {
			let msg = res.text.slice(0, 300);
			try {
				msg = (JSON.parse(res.text) as { message?: string }).message ?? msg;
			} catch {
				/* non JSON */
			}
			if (res.status === 403) msg = `accès refusé (${msg}) — le jeton n'a pas ce droit`;
			throw new ExternalApiError('OVH', `${method} ${path} : HTTP ${res.status} ${msg}`, res.status);
		}
		return res.text ? parseJson<T>('OVH', res.text) : (null as T);
	}

	async currentCredential(): Promise<OvhCredential> {
		const c = await this.#call<{ status: string; applicationId?: number; expiration?: string | null; rules?: { method: string; path: string }[] }>(
			'GET',
			'/auth/currentCredential'
		);
		return { status: c.status, applicationId: c.applicationId ?? null, expiration: c.expiration ?? null, rules: c.rules ?? [] };
	}

	listZones() {
		return this.#call<string[]>('GET', '/domain/zone');
	}

	listRecordIds(zone: string, filter: { subDomain?: string; fieldType?: string } = {}) {
		const query: Record<string, string> = {};
		if (filter.subDomain) query.subDomain = filter.subDomain;
		if (filter.fieldType) query.fieldType = filter.fieldType;
		return this.#call<number[]>('GET', `/domain/zone/${encodeURIComponent(zone)}/record`, { query });
	}

	getRecord(zone: string, id: number) {
		return this.#call<OvhRecord>('GET', `/domain/zone/${encodeURIComponent(zone)}/record/${id}`);
	}

	createRecord(zone: string, record: { fieldType: string; subDomain: string; target: string; ttl: number }) {
		return this.#call<OvhRecord>('POST', `/domain/zone/${encodeURIComponent(zone)}/record`, { body: record });
	}

	async refreshZone(zone: string) {
		await this.#call('POST', `/domain/zone/${encodeURIComponent(zone)}/refresh`);
	}

	async deleteRecord(zone: string, id: number) {
		await this.#call('DELETE', `/domain/zone/${encodeURIComponent(zone)}/record/${id}`);
	}
}

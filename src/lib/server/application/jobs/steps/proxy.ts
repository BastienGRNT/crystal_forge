/** Étape 6 — Proxy host NPM + certificat Let's Encrypt, un par domaine. */
import { servesDomain } from '$lib/domain/domain-name';
import type { StepDefinition } from '../types';
import { requireIp } from './common';
import { targetDomains } from './dns';
import type { ResourceRow } from '$server/infrastructure/db/schema';

function resourceFqdn(r: ResourceRow): string | undefined {
	try {
		return (JSON.parse(r.meta) as { fqdn?: string }).fqdn;
	} catch {
		return undefined;
	}
}

/** Date NPM « 2027-01-07 22:01:04 » (UTC) encore à plus d'un jour. */
function certStillValid(expiresOn: string | null): boolean {
	if (!expiresOn) return false;
	const t = Date.parse(expiresOn.replace(' ', 'T') + 'Z');
	return Number.isFinite(t) && t > Date.now() + 86400_000;
}

export const proxyStep: StepDefinition = {
	key: 'npm',
	label: 'Proxy NPM & HTTPS',
	async run(ctx) {
		const { proxy, settings, repos } = ctx.services;
		const p = ctx.project();
		const ip = requireIp(ctx);
		const domains = targetDomains(ctx);
		if (domains.length === 0) {
			ctx.log('warn', 'Aucun domaine : étape ignorée.');
			return;
		}
		let email = settings.get('letsencrypt.email');
		if (!email) {
			email = (await proxy.api.me()).email;
			ctx.log('info', `Email Let's Encrypt non défini dans Réglages : NPM utilisera celui du compte (${email}).`);
		}

		// État réel (pas le cache d'affichage) : un proxy host créé hors Forge doit être vu.
		const hosts = await proxy.api.listProxyHosts();
		const owned = repos.resources.active({ projectId: p.id });
		for (const d of domains) {
			const existing = hosts.find((h) => servesDomain(h.domainNames, d.fqdn));
			// Certificat Forge encore présent dans NPM pour ce domaine : réutilisé si le proxy host est à recréer.
			let reuseCert: number | undefined;
			if (d.status === 'active') {
				if (existing) {
					ctx.log('info', `${d.fqdn} : proxy host déjà actif.`);
					continue;
				}
				// Domaine actif mais proxy host disparu (supprimé à la main dans NPM) : on le recrée.
				for (const r of owned.filter((x) => x.type === 'npm_proxy_host' && resourceFqdn(x) === d.fqdn)) {
					if (!ctx.dryRun) repos.resources.markDeleted('npm_proxy_host', r.externalId);
				}
				const certs = await proxy.listCertificates();
				const mine = owned.filter((x) => x.type === 'npm_certificate' && resourceFqdn(x) === d.fqdn).map((x) => Number(x.externalId));
				reuseCert = certs
					.filter((c) => mine.includes(c.id) && servesDomain(c.domainNames, d.fqdn) && certStillValid(c.expiresOn))
					.sort((a, b) => b.id - a.id)[0]?.id;
				ctx.log('warn', `${d.fqdn} : proxy host introuvable dans NPM (supprimé hors Forge) : recréation${reuseCert ? ` avec le certificat #${reuseCert}` : ''}.`);
			}
			if (existing) {
				if (repos.resources.findActive('npm_proxy_host', String(existing.id))) {
					ctx.log('info', `${d.fqdn} : proxy host #${existing.id} déjà créé par Forge.`);
					if (!ctx.dryRun) repos.domains.update(d.id, { status: 'active' });
					continue;
				}
				throw new Error(`Un proxy host NPM existe déjà pour ${d.fqdn} (#${existing.id} → ${existing.forwardHost}:${existing.forwardPort}), créé hors Forge. Rien n'est écrasé.`);
			}
			if (!reuseCert) ctx.log('info', `${d.fqdn} : création du proxy host et demande du certificat Let's Encrypt (jusqu'à 2-3 min)…`);
			const host = await proxy.createProxyHost({ domain: d.fqdn, forwardHost: ip, forwardPort: p.appPort, email, certificateId: reuseCert });
			ctx.recordResource('npm_proxy_host', host.id, { fqdn: d.fqdn });
			if (host.certificateId > 0 && host.certificateId !== reuseCert) ctx.recordResource('npm_certificate', host.certificateId, { fqdn: d.fqdn });
			if (!ctx.dryRun) {
				const expires = host.certificate?.expiresOn ? Date.parse(host.certificate.expiresOn.replace(' ', 'T') + 'Z') : null;
				repos.domains.update(d.id, { status: 'active', sslStatus: 'valid', sslExpiresAt: Number.isFinite(expires) ? expires : null });
			}
			ctx.log('success', `${d.fqdn} → http://${ip}:${p.appPort} (proxy host #${host.id}, certificat #${host.certificateId}).`);
		}
	}
};

/** Changement de port : chaque proxy host créé par Forge pour le projet vise le nouveau port. */
export const proxyRepointStep: StepDefinition = {
	key: 'npm_repoint',
	label: 'Proxy NPM : nouveau port',
	async run(ctx) {
		const { proxy, repos } = ctx.services;
		const p = ctx.project();
		const ip = requireIp(ctx);
		const owned = repos.resources.active({ projectId: p.id }).filter((r) => r.type === 'npm_proxy_host');
		if (owned.length === 0) {
			ctx.log('info', 'Aucun proxy host créé par Forge : rien à rediriger.');
			return;
		}
		const hosts = await proxy.api.listProxyHosts();
		for (const r of owned) {
			const host = hosts.find((h) => String(h.id) === r.externalId);
			if (!host) {
				ctx.log('warn', `Proxy host #${r.externalId} introuvable dans NPM (supprimé à la main ?) : ignoré.`);
				continue;
			}
			const name = host.domainNames.join(', ');
			if (host.forwardHost === ip && host.forwardPort === p.appPort) {
				ctx.log('info', `${name} : vise déjà http://${ip}:${p.appPort}.`);
				continue;
			}
			await proxy.repointProxyHost(host.id, ip, p.appPort);
			ctx.log('success', `${name} : http://${host.forwardHost}:${host.forwardPort} → http://${ip}:${p.appPort} (certificat conservé).`);
		}
	}
};

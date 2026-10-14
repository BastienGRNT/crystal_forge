/** Étape 6 — Proxy host NPM + certificat Let's Encrypt, un par domaine. */
import type { StepDefinition } from '../types';
import { requireIp } from './common';
import { targetDomains } from './dns';

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

		const hosts = await proxy.listHosts();
		for (const d of domains) {
			if (d.status === 'active') {
				ctx.log('info', `${d.fqdn} : proxy host déjà actif.`);
				continue;
			}
			const existing = hosts.find((h) => h.domainNames.map((x) => x.toLowerCase()).includes(d.fqdn));
			if (existing) {
				if (repos.resources.findActive('npm_proxy_host', String(existing.id))) {
					ctx.log('info', `${d.fqdn} : proxy host #${existing.id} déjà créé par Forge.`);
					if (!ctx.dryRun) repos.domains.update(d.id, { status: 'active' });
					continue;
				}
				throw new Error(`Un proxy host NPM existe déjà pour ${d.fqdn} (#${existing.id} → ${existing.forwardHost}:${existing.forwardPort}), créé hors Forge. Rien n'est écrasé.`);
			}
			ctx.log('info', `${d.fqdn} : création du proxy host et demande du certificat Let's Encrypt (jusqu'à 2-3 min)…`);
			const host = await proxy.createProxyHost({ domain: d.fqdn, forwardHost: ip, forwardPort: p.appPort, email });
			ctx.recordResource('npm_proxy_host', host.id, { fqdn: d.fqdn });
			if (host.certificateId > 0) ctx.recordResource('npm_certificate', host.certificateId, { fqdn: d.fqdn });
			if (!ctx.dryRun) {
				const expires = host.certificate?.expiresOn ? Date.parse(host.certificate.expiresOn.replace(' ', 'T') + 'Z') : null;
				repos.domains.update(d.id, { status: 'active', sslStatus: 'valid', sslExpiresAt: Number.isFinite(expires) ? expires : null });
			}
			ctx.log('success', `${d.fqdn} → http://${ip}:${p.appPort} (proxy host #${host.id}, certificat #${host.certificateId}).`);
		}
	}
};

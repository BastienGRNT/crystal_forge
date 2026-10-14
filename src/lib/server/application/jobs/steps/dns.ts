/** Étape 5 — DNS : enregistrements A chez OVH (ou à la main), puis attente de la résolution publique. */
import { wildcardCovering } from '$lib/domain/safety-policy';
import type { DomainRow } from '$server/infrastructure/db/schema';
import type { StepContext, StepDefinition } from '../types';
import { fmtDuration, waitFor } from './common';

export function targetDomains(ctx: StepContext): DomainRow[] {
	const all = ctx.services.repos.domains.byProject(ctx.project().id);
	const ids = ctx.params.domainIds as number[] | undefined;
	return ids ? all.filter((d) => ids.includes(d.id)) : all;
}

export const dnsStep: StepDefinition = {
	key: 'dns',
	label: 'DNS',
	async run(ctx) {
		const { dns, settings, repos, resolver } = ctx.services;
		const publicIp = settings.get('network.publicIp');
		const domains = targetDomains(ctx);
		if (domains.length === 0) {
			ctx.log('warn', 'Aucun domaine configuré : étape ignorée.');
			return;
		}

		const zones = domains.some((d) => d.mode === 'ovh') ? await dns.listZones() : [];
		const manual: { fqdn: string; ip: string }[] = [];
		const created = new Set<string>((ctx.state.created as string[] | undefined) ?? []);

		for (const d of domains) {
			if (d.status === 'dns_ok' || d.status === 'active') {
				ctx.log('info', `${d.fqdn} : DNS déjà validé.`);
				continue;
			}
			if (d.mode === 'manual' || !d.zone || !zones.includes(d.zone)) {
				manual.push({ fqdn: d.fqdn, ip: publicIp });
				ctx.log('warn', `${d.fqdn} : domaine hors OVH → créez à la main l'enregistrement  A  ${d.fqdn}  →  ${publicIp}  (pas d'AAAA).`);
				continue;
			}
			const existing = await dns.recordsFor(d.zone, d.subdomain);
			const sameA = existing.find((r) => r.fieldType === 'A' && r.target === publicIp);
			const owned = sameA && repos.resources.findActive('ovh_record', `${d.zone}:${sameA.id}`);
			if (sameA) {
				ctx.log(
					owned ? 'info' : 'warn',
					owned
						? `${d.fqdn} : enregistrement A #${sameA.id} déjà créé par Forge.`
						: `${d.fqdn} : un enregistrement A → ${publicIp} existe déjà (créé hors Forge) : utilisé tel quel, Forge ne le gérera pas.`
				);
				continue;
			}
			const wildcard = wildcardCovering(d.subdomain, await dns.wildcardRecords(d.zone, d.subdomain));
			if (wildcard) ctx.log('warn', `${d.fqdn} : un wildcard ${wildcard.subDomain}.${d.zone} (${wildcard.fieldType} → ${wildcard.target}) couvre déjà ce nom.`);

			const rec = await dns.createARecord(d.zone, d.subdomain);
			ctx.recordResource('ovh_record', `${d.zone}:${rec.id}`, { fqdn: d.fqdn });
			await dns.refreshZone(d.zone);
			created.add(d.fqdn);
			ctx.state.created = [...created];
			ctx.save();
			ctx.log('success', `${d.fqdn} : A → ${publicIp} créé (#${rec.id}, TTL 300) et zone rafraîchie.`);
		}

		if (manual.length) {
			ctx.state.manual = manual;
			ctx.save();
		}

		// --- Attente de la résolution publique (DoH dns.google) ------------------------------
		for (const d of domains) {
			if (d.status === 'dns_ok' || d.status === 'active') continue;
			const isManual = manual.some((m) => m.fqdn === d.fqdn);
			if (ctx.dryRun && created.has(d.fqdn)) {
				ctx.log('dry', `[DRY-RUN] Attente de la résolution de ${d.fqdn} simulée.`);
				continue;
			}
			ctx.log('info', `Attente de la résolution publique de ${d.fqdn} → ${publicIp} (dns.google)…`);
			const timeoutMs = isManual ? 30 * 60_000 : 15 * 60_000;
			let last = '';
			let lastLog = Date.now();
			await waitFor(
				ctx,
				async () => {
					const ips = await resolver()
						.resolveA(d.fqdn)
						.catch(() => [] as string[]);
					last = ips.join(', ');
					return ips.includes(publicIp);
				},
				{
					intervalMs: ctx.services.config.mode === 'mock' ? 2000 : 10_000,
					timeoutMs,
					timeoutMessage: `${d.fqdn} ne résout pas vers ${publicIp} après ${fmtDuration(timeoutMs)} (réponse actuelle : ${last || 'aucune'}). Vérifiez l'enregistrement puis « Reprendre ».`,
					onTick: (ms) => {
						if (Date.now() - lastLog >= 60_000 || ctx.services.config.mode === 'mock') {
							lastLog = Date.now();
							ctx.log('info', `… ${d.fqdn} pas encore visible (${fmtDuration(ms)}, réponse : ${last || 'aucune'})`);
						}
					}
				}
			);
			if (!ctx.dryRun) repos.domains.update(d.id, { status: 'dns_ok' });
			ctx.log('success', `${d.fqdn} résout vers ${publicIp}.`);
		}
	}
};

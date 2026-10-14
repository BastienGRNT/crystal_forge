/** Étape « Pare-feu » : isole le CT du projet des autres CT du bridge (prod comprise). */
import { FIREWALL_OPTIONS, planFirewallRules, subnetOf, withFirewallFlag } from '$lib/domain/firewall';
import type { ProjectRow } from '$server/infrastructure/db/schema';
import type { ForgeServices } from '../../services';
import type { StepDefinition } from '../types';

export function firewallPlan(s: ForgeServices, p: Pick<ProjectRow, 'appPort'>) {
	const gateway = s.settings.get('network.gateway');
	return planFirewallRules({
		appPort: p.appPort,
		npmIp: s.settings.get('network.npmIp'),
		forgeIp: s.settings.get('network.forgeIp') || null,
		gateway,
		subnet: subnetOf(gateway, s.settings.int('network.cidr'))
	});
}

export const firewallStep: StepDefinition = {
	key: 'firewall',
	label: 'Pare-feu',
	async run(ctx) {
		const { proxmox, settings } = ctx.services;
		const p = ctx.project();
		if (!settings.bool('firewall.enabled') && !ctx.params.forceFirewall) {
			ctx.log('info', 'Pare-feu par CT désactivé (Réglages → Réseau) : étape ignorée.');
			return;
		}
		if (!p.ctid) throw new Error('Le projet n’a pas encore de CT.');
		const ctid = p.ctid;

		// Le pare-feu d'un CT ne filtre que les interfaces marquées firewall=1.
		const cfg = await proxmox.guestConfig(ctid);
		const net0 = String(cfg.net0 ?? '');
		if (net0 && !/(^|,)firewall=1(,|$)/.test(net0)) {
			await proxmox.configure(ctid, { net0: withFirewallFlag(net0) });
			ctx.log('success', 'Interface eth0 : filtrage par le pare-feu Proxmox activé (firewall=1).');
		}

		const plan = firewallPlan(ctx.services, p);
		const status = await proxmox.firewallStatus(ctid, plan).catch(() => null);
		if (status?.upToDate && status.options.ipfilter == 1) {
			ctx.log('info', 'Pare-feu déjà à jour.');
		} else {
			await proxmox.applyFirewall(ctid, plan, FIREWALL_OPTIONS);
			for (const r of plan) {
				ctx.log('debug', `${r.type.toUpperCase()} ${r.action} ${r.source ? `de ${r.source}` : ''}${r.dest ? `vers ${r.dest}` : ''}${r.proto ? ` ${r.proto}` : ''}${r.dport ? `/${r.dport}` : ''} — ${r.comment}`);
			}
			ctx.log('success', `Pare-feu appliqué : seul NPM (${settings.get('network.npmIp')}) atteint le port ${p.appPort}, le reste du bridge est bloqué.`);
		}

		const cluster = await proxmox.api.clusterFirewallOptions().catch(() => null);
		if (cluster && Number(cluster.enable ?? 0) !== 1) {
			ctx.log('warn', 'Le pare-feu du datacenter est désactivé : les règles sont enregistrées mais pas appliquées. Lancez infra/05-firewall.sh sur l’hôte.');
		}
		if (!ctx.dryRun) ctx.updateProject({ firewallAppliedAt: Date.now() });
	}
};

/** Étape 1 — Conteneur : clone du template, configuration, démarrage, attente SSH. */
import { candidateIps, nextFreeCtid, pickFreeIp } from '$lib/domain/allocation';
import { buildNet0 } from '$lib/domain/network';
import type { StepDefinition } from '../types';
import { requireIp, sizeOf, waitFor } from './common';

export const containerStep: StepDefinition = {
	key: 'ct',
	label: 'Conteneur LXC',
	async run(ctx) {
		const { proxmox, settings, repos, probe } = ctx.services;
		let p = ctx.project();
		const size = sizeOf(p);
		const range = { min: settings.int('ctid.min'), max: settings.int('ctid.max') };
		// Les jobs lisent l'état réel de Proxmox, jamais le cache d'affichage.
		const guests = await proxmox.api.guests();

		// --- 1. Allocation CTID + IP (une seule fois ; réservée en base aussitôt) -------------
		if (!p.ctid || !p.ip) {
			ctx.log('info', 'Lecture de la configuration réseau de TOUS les CT et VM…');
			const used = await proxmox.usedIps(guests);
			const reserved = repos.projects.reservedAllocations();
			const ctid =
				p.ctid ??
				nextFreeCtid(
					guests.map((g) => g.vmid),
					range,
					[...reserved.ctids, ...settings.safetyContext().protectedCtids]
				);
			if (!ctid) throw new Error(`Plus aucun CTID libre dans la plage ${range.min}-${range.max}.`);
			if (!p.ctid && !(await proxmox.isIdFree(ctid))) throw new Error(`Proxmox indique que le CTID ${ctid} est déjà pris.`);

			let ip = p.ip;
			if (!ip) {
				const candidates = candidateIps(
					[...used.map((u) => u.ip), ...reserved.ips],
					{ start: settings.get('network.ipStart'), end: settings.get('network.ipEnd') },
					settings.list('network.reservedIps')
				);
				ctx.log('info', `${used.length} IP déclarées dans les configs, ${candidates.length} candidates dans la plage Forge. Contrôle ping/ARP…`);
				const picked = await pickFreeIp(candidates, async (c) => (await probe().ping(c)) || (await probe().arpHas(c)) === true);
				for (const s of picked.skipped) ctx.log('warn', `${s} répond au ping/ARP sans être déclarée dans un CT : ignorée.`);
				if (!picked.ip) throw new Error('Aucune IP libre dans la plage Forge.');
				ip = picked.ip;
			}
			p = ctx.updateProject({ ctid, ip });
			ctx.log('success', `Attribué : CT ${ctid} — IP ${ip}`);
		}
		const ctid = p.ctid as number;
		const ip = requireIp(ctx);

		// --- 2. Clone (idempotent) ---------------------------------------------------------------
		const existing = guests.find((g) => g.vmid === ctid);
		const ownsIt = repos.resources.findActive('pve_ct', String(ctid));
		if (existing && !ownsIt) {
			throw new Error(`Le CTID ${ctid} est occupé par « ${existing.name} », qui n'a pas été créé par Forge. Rien n'est modifié.`);
		}
		if (!existing && !ctx.state.cloned) {
			const upid = await proxmox.cloneTemplate(ctid, p.slug, `Projet Forge « ${p.name} » — dépôt ${p.repoOwner}/${p.repoName}.\nGéré par Forge : ne pas modifier à la main.`);
			ctx.recordResource('pve_ct', ctid, { hostname: p.slug, ip });
			ctx.log('info', 'Clone complet en cours (peut prendre une minute)…');
			await proxmox.waitTask(upid, { timeoutMs: 15 * 60_000, onLine: (l) => ctx.log('debug', l) });
			ctx.state.cloned = true;
			ctx.save();
			ctx.log('success', `CT ${ctid} cloné depuis le template ${settings.get('proxmox.templateId')}.`);
		} else {
			ctx.log('info', `CT ${ctid} déjà présent (reprise) : clone ignoré.`);
		}

		// --- 3. Configuration ----------------------------------------------------------------------
		// Sans nameserver, le CT hérite du resolv.conf de l'hôte (ex. Tailscale 100.100.100.100).
		const nameserver = settings.get('network.nameserver').trim();
		await proxmox.configure(ctid, {
			cores: size.cores,
			memory: size.memoryMb,
			swap: size.swapMb,
			net0: buildNet0({ ip, cidr: settings.int('network.cidr'), gateway: settings.get('network.gateway'), bridge: settings.get('proxmox.bridge') }),
			onboot: 1,
			// Le clone hérite de protection=1 du template (infra/03) : sans ce 0, Proxmox
			// refuse ensuite le rollback et la suppression du projet (« CT is protected »).
			protection: 0,
			...(nameserver ? { nameserver } : {}),
			tags: 'forge'
		});
		ctx.log('success', `Configuré : ${size.cores} cœur(s), ${size.memoryMb} Mo RAM, ${size.swapMb} Mo swap, ${ip}/${settings.int('network.cidr')} sur ${settings.get('proxmox.bridge')}.`);

		// --- 4. Disque (agrandissement uniquement) ------------------------------------------------
		const cfg = await proxmox.guestConfig(ctid);
		const currentGb = Number(/size=(\d+)G/.exec(String(cfg.rootfs ?? ''))?.[1] ?? 0);
		if (currentGb < size.diskGb) {
			const upid = await proxmox.resize(ctid, size.diskGb);
			if (upid) await proxmox.waitTask(upid, { timeoutMs: 5 * 60_000 });
			ctx.log('success', `Disque agrandi de ${currentGb || '?'} à ${size.diskGb} Go.`);
		} else {
			ctx.log('info', `Disque déjà à ${currentGb} Go.`);
		}

		// --- 5. Démarrage + SSH -------------------------------------------------------------------
		const status = (await proxmox.api.guests()).find((g) => g.vmid === ctid)?.status;
		if (status !== 'running') {
			const upid = await proxmox.power(ctid, 'start');
			await proxmox.waitTask(upid, { timeoutMs: 2 * 60_000 });
			ctx.log('success', `CT ${ctid} démarré.`);
		}
		if (ctx.dryRun) {
			ctx.log('dry', `[DRY-RUN] Attente du SSH sur ${ip}:22 simulée.`);
			return;
		}
		ctx.log('info', `Attente du SSH sur ${ip}:22…`);
		await waitFor(ctx, () => probe().tcpOpen(ip, 22, 2000), {
			intervalMs: 2000,
			timeoutMs: 3 * 60_000,
			timeoutMessage: `Le SSH ne répond pas sur ${ip}:22 après 3 min (le CT a-t-il démarré ? la clé SSH est-elle dans le template ?).`
		});
		const res = await ctx.services.shell.ping({ ip, sshHostKey: ctx.project().sshHostKey });
		ctx.log('success', `SSH opérationnel (clé d'hôte ${res.hostKey}).`);
	}
};

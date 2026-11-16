/**
 * CT de build : un seul CT, créé et allumé à la demande, éteint après N minutes sans build.
 * Il construit les images d'un projet à la fois ; les CT des projets ne construisent plus rien.
 * Toutes les écritures passent par les passerelles (garde, DRY_RUN, propriété des CT).
 */
import { candidateIps, nextFreeCtid, pickFreeIp } from '$lib/domain/allocation';
import { BUILDER_HOSTNAME, builderFits } from '$lib/domain/builder';
import { errorMessage } from '$lib/domain/errors';
import { CPU_WEIGHTS } from '$lib/domain/host-maintenance';
import { buildNet0 } from '$lib/domain/network';
import { hostMemoryInUse } from '$lib/domain/sizes';
import type { ShellTarget } from './gateways';
import type { ForgeServices } from './services';

type Log = (level: 'info' | 'success' | 'warn' | 'dry' | 'debug', message: string) => void;

/** Dernière utilisation du CT de build (en mémoire : au redémarrage de Forge, il s'éteint au délai suivant). */
const state = { lastUsedAt: Date.now(), inUse: 0 };

export function builderTarget(s: ForgeServices): ShellTarget | null {
	const ip = s.settings.get('builder.ip');
	return ip ? { ip, sshHostKey: s.settings.get('builder.hostKey') || null } : null;
}

export function markBuilderUse(delta: 1 | -1) {
	state.inUse = Math.max(0, state.inUse + delta);
	state.lastUsedAt = Date.now();
}

export interface BuilderInfo {
	ctid: number | null;
	ip: string | null;
	status: 'absent' | 'running' | 'stopped';
	cores: number;
	memoryMb: number;
	diskGb: number;
	idleMin: number;
	lastUsedAt: number | null;
}

export async function builderInfo(s: ForgeServices): Promise<BuilderInfo> {
	const ctid = Number(s.settings.get('builder.ctid')) || null;
	const g = ctid ? (await s.proxmox.guests().catch(() => [])).find((x) => x.vmid === ctid) : undefined;
	return {
		ctid,
		ip: s.settings.get('builder.ip') || null,
		status: !g ? 'absent' : g.status === 'running' ? 'running' : 'stopped',
		cores: s.settings.int('builder.cores'),
		memoryMb: s.settings.int('builder.memoryMb'),
		diskGb: s.settings.int('builder.diskGb'),
		idleMin: s.settings.int('builder.idleMin'),
		lastUsedAt: state.lastUsedAt || null
	};
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Crée (si besoin) et allume le CT de build. Renvoie null si l'hôte n'a pas la RAM
 * pour l'allumer : le projet est alors construit dans son propre CT (repli).
 */
export async function ensureBuilder(s: ForgeServices, log: Log, dryRun: boolean): Promise<ShellTarget | null> {
	const { proxmox, settings, repos, probe } = s;
	const memoryMb = settings.int('builder.memoryMb');
	const guests = await proxmox.api.guests();
	let ctid = Number(settings.get('builder.ctid')) || null;
	let ip = settings.get('builder.ip') || null;
	let existing = ctid ? guests.find((g) => g.vmid === ctid) : undefined;

	if (existing && !repos.resources.findActive('pve_ct', String(ctid))) {
		throw new Error(`Le CT ${ctid} noté comme CT de build n'a pas été créé par Forge (« ${existing.name} ») : rien n'est modifié. Videz le réglage builder.ctid.`);
	}

	if (!existing || existing.status !== 'running') {
		const n = await proxmox.nodeStatus();
		if (!builderFits(hostMemoryInUse(n.memory), n.memory.total, memoryMb * 1024 ** 2)) {
			log('warn', `RAM du serveur insuffisante pour allumer le CT de build (${memoryMb} Mo) : construction dans le CT du projet, une image à la fois.`);
			return null;
		}
	}

	if (!existing) {
		// --- Allocation (gardée dans les réglages tout de suite, comme pour un projet) ---------
		const range = { min: settings.int('ctid.min'), max: settings.int('ctid.max') };
		const reserved = repos.projects.reservedAllocations();
		if (!ctid || !(await proxmox.isIdFree(ctid))) {
			ctid = nextFreeCtid(
				guests.map((g) => g.vmid),
				range,
				[...reserved.ctids, ...settings.safetyContext().protectedCtids]
			);
			if (!ctid) throw new Error(`Plus aucun CTID libre dans la plage ${range.min}-${range.max} pour le CT de build.`);
		}
		if (!ip) {
			const used = await proxmox.usedIps(guests);
			const candidates = candidateIps(
				[...used.map((u) => u.ip), ...reserved.ips],
				{ start: settings.get('network.ipStart'), end: settings.get('network.ipEnd') },
				settings.list('network.reservedIps')
			);
			const picked = await pickFreeIp(candidates, async (c) => (await probe().ping(c)) || (await probe().arpHas(c)) === true);
			if (!picked.ip) throw new Error('Aucune IP libre dans la plage Forge pour le CT de build.');
			ip = picked.ip;
		}
		settings.set({ 'builder.ctid': String(ctid), 'builder.ip': ip, 'builder.hostKey': '' });
		log('info', `Création du CT de build : CT ${ctid}, IP ${ip}.`);

		const upid = await proxmox.cloneTemplate(ctid, BUILDER_HOSTNAME, 'CT de build de Forge : construit les images Docker des projets, puis s’éteint.\nGéré par Forge : ne pas modifier à la main.');
		// Sans projet ni job : supprimer un projet ou annuler un job ne touche jamais au CT de build.
		if (!dryRun) repos.resources.record({ type: 'pve_ct', externalId: ctid, projectId: null, jobId: null, meta: { hostname: BUILDER_HOSTNAME, ip, builder: true } });
		try {
			await proxmox.waitTask(upid, { timeoutMs: 15 * 60_000 });
		} catch (err) {
			const msg = errorMessage(err);
			if (/no mountpoint set/i.test(msg)) {
				throw new Error(`Le stockage ZFS « forge-ct » n'a pas de point de montage sur l'hôte : relancez bash infra/bootstrap.sh (il le règle), puis relancez ce job. (${msg})`);
			}
			throw err;
		}

		const nameserver = settings.get('network.nameserver').trim();
		await proxmox.configure(ctid, {
			cores: settings.int('builder.cores'),
			memory: memoryMb,
			swap: 1024,
			// Les builds passent après la prod et les sites de dev.
			cpuunits: CPU_WEIGHTS.development,
			net0: buildNet0({ ip, cidr: settings.int('network.cidr'), gateway: settings.get('network.gateway'), bridge: settings.get('proxmox.bridge') }),
			onboot: 0,
			protection: 0,
			...(nameserver ? { nameserver } : {}),
			tags: 'forge;builder'
		});
		const diskGb = settings.int('builder.diskGb');
		const upidR = await proxmox.resize(ctid, diskGb);
		if (upidR) await proxmox.waitTask(upidR, { timeoutMs: 5 * 60_000 });
		log('success', `CT de build ${ctid} créé (${settings.int('builder.cores')} cœurs, ${memoryMb} Mo, ${diskGb} Go).`);
		existing = undefined;
	}

	const id = ctid as number;
	const addr = ip as string;
	if (existing?.status !== 'running') {
		await proxmox.waitTask(await proxmox.power(id, 'start'), { timeoutMs: 2 * 60_000 });
		log('info', `CT de build ${id} allumé.`);
	}
	if (dryRun) {
		log('dry', `[DRY-RUN] Attente du SSH du CT de build (${addr}) simulée.`);
		return { ip: addr, sshHostKey: settings.get('builder.hostKey') || null };
	}
	const deadline = Date.now() + 3 * 60_000;
	while (!(await probe().tcpOpen(addr, 22, 2000))) {
		if (Date.now() > deadline) throw new Error(`Le SSH du CT de build ne répond pas sur ${addr}:22 après 3 min.`);
		await tick(2000);
	}
	const t = { ip: addr, sshHostKey: settings.get('builder.hostKey') || null };
	await s.shell.ping(t);
	return { ip: addr, sshHostKey: settings.get('builder.hostKey') || null };
}

/** Éteint le CT de build après le délai sans build (appelé par la surveillance). */
export async function idleShutdownBuilder(s: ForgeServices): Promise<void> {
	const ctid = Number(s.settings.get('builder.ctid')) || null;
	if (!ctid || state.inUse > 0) return;
	const idleMs = s.settings.int('builder.idleMin') * 60_000;
	if (Date.now() - state.lastUsedAt < idleMs) return;
	const g = (await s.proxmox.guests().catch(() => [])).find((x) => x.vmid === ctid);
	if (g?.status !== 'running') return;
	if (!s.repos.resources.findActive('pve_ct', String(ctid))) return;
	if (s.guard.isDryRun()) return;
	try {
		await s.proxmox.waitTask(await s.proxmox.power(ctid, 'shutdown'), { timeoutMs: 3 * 60_000 });
		console.info(`[build] CT de build ${ctid} éteint (aucun build depuis ${s.settings.int('builder.idleMin')} min).`);
	} catch (err) {
		console.warn(`[build] extinction du CT de build : ${errorMessage(err)}`);
	}
}

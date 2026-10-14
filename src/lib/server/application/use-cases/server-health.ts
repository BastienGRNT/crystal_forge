/**
 * Page « Santé du serveur » : contrôles en LECTURE SEULE de tout ce dont Forge dépend
 * (hôte Proxmox, réseau, pare-feu, sauvegardes, NPM, accès Tailscale). Pour chaque point
 * manquant, la commande ou le script à lancer soi-même sur l'hôte.
 */
import { errorMessage } from '$lib/domain/errors';
import { hasFirewallFlag, INTERNET_PROBE_URL, parseInternetProbe } from '$lib/domain/firewall';
import { inCidr } from '$lib/domain/network';
import { ReadCommand } from '../gateways';
import { CONNTRACK_FIX } from '../jobs/steps/common';
import type { ForgeServices } from '../services';
import { firewallPlan } from '../jobs/steps/firewall';
import { poolAuditFix } from './connections';

export type HealthStatus = 'ok' | 'warn' | 'error' | 'info';

export interface HealthCheck {
	id: string;
	group: string;
	label: string;
	status: HealthStatus;
	detail: string;
	fix?: string;
	/** Projets dont le pare-feu peut être (ré)appliqué depuis cette page. */
	projects?: { slug: string; name: string; ctid: number; upToDate: boolean }[];
}

const GiB = 1024 ** 3;

async function safe(fn: () => Promise<HealthCheck | HealthCheck[]>, fallback: Omit<HealthCheck, 'status' | 'detail'>): Promise<HealthCheck[]> {
	try {
		const r = await fn();
		return Array.isArray(r) ? r : [r];
	} catch (err) {
		return [{ ...fallback, status: 'error', detail: errorMessage(err) }];
	}
}

export class ServerHealthService {
	constructor(private readonly s: ForgeServices) {}

	async run(clientIp: string | null): Promise<{ checks: HealthCheck[]; checkedAt: number }> {
		const { proxmox, settings, repos } = this.s;
		const templateId = settings.int('proxmox.templateId');
		const pool = settings.get('proxmox.pool');
		const protectedIds = settings.safetyContext().protectedCtids;
		const guestsP = proxmox.guests();
		guestsP.catch(() => {});

		const groups = await Promise.all([
			safe(
				async () => {
					const v = await proxmox.version();
					return { id: 'pve', group: 'Proxmox', label: 'API Proxmox', status: 'ok', detail: `Proxmox VE ${v.version} (${settings.get('proxmox.node')})` };
				},
				{ id: 'pve', group: 'Proxmox', label: 'API Proxmox', fix: 'Réglages → Proxmox, puis infra/02-proxmox-forge-access.sh si le jeton n’existe pas.' }
			),
			safe(
				async () => {
					const g = (await guestsP).find((x) => x.vmid === templateId);
					if (!g) {
						return { id: 'template', group: 'Proxmox', label: `Template ${templateId}`, status: 'error', detail: 'Introuvable.', fix: `bash infra/03-template-docker-runner.sh "<clé publique de Réglages → Clé SSH>"` };
					}
					const problems = [!g.template && 'pas converti en template', g.pool !== pool && `hors du pool « ${pool} »`].filter(Boolean);
					return problems.length
						? {
								id: 'template',
								group: 'Proxmox',
								label: `Template ${templateId}`,
								status: 'error',
								detail: `« ${g.name} » : ${problems.join(', ')}.`,
								// Champ pool absent : souvent Pool.Audit manquant (Proxmox masque alors le pool).
								fix: g.pool === null ? `S’il est bien dans le pool : ${poolAuditFix(pool, settings.get('proxmox.tokenId'))}` : 'Relancez infra/03-template-docker-runner.sh.'
							}
						: { id: 'template', group: 'Proxmox', label: `Template ${templateId}`, status: 'ok', detail: `« ${g.name} », dans le pool ${pool}.` };
				},
				{ id: 'template', group: 'Proxmox', label: `Template ${templateId}` }
			),
			safe(
				async () => {
					const n = await proxmox.nodeStatus();
					const freePct = (n.memory.free / n.memory.total) * 100;
					const ram: HealthCheck = {
						id: 'ram',
						group: 'Proxmox',
						label: 'Mémoire de l’hôte',
						status: freePct < 10 ? 'error' : freePct < 20 ? 'warn' : 'ok',
						detail: `${(n.memory.free / GiB).toFixed(1)} Go libres sur ${(n.memory.total / GiB).toFixed(1)} Go (${Math.round(freePct)} %).`,
						fix: freePct < 20 ? 'Réduisez la taille d’un projet ou arrêtez un CT inutilisé.' : undefined
					};
					const st = await proxmox.storageStatus();
					const diskPct = (st.avail / st.total) * 100;
					const disk: HealthCheck = {
						id: 'storage',
						group: 'Proxmox',
						label: `Stockage « ${settings.get('proxmox.storage')} »`,
						status: diskPct < 10 ? 'error' : diskPct < 20 ? 'warn' : 'ok',
						detail: `${(st.avail / GiB).toFixed(0)} Go libres sur ${(st.total / GiB).toFixed(0)} Go (${Math.round(diskPct)} %).`,
						fix: diskPct < 20 ? 'Supprimez d’anciennes sauvegardes dans /var/lib/vz/dump.' : undefined
					};
					return [ram, disk];
				},
				{ id: 'ram', group: 'Proxmox', label: 'Ressources de l’hôte' }
			),
			safe(
				async () => {
					const full = (await guestsP).filter((g) => !g.template && g.status === 'running' && g.maxdisk > 0 && g.disk / g.maxdisk > 0.8);
					const forgeSlugs = new Map(repos.projects.list().filter((p) => p.ctid).map((p) => [p.ctid as number, p.slug]));
					return full.length
						? {
								id: 'ct-disks',
								group: 'Proxmox',
								label: 'Disques des CT',
								status: full.some((g) => g.disk / g.maxdisk > 0.92) ? 'error' : 'warn',
								detail: full.map((g) => `CT ${g.vmid} ${g.name} : ${Math.round((g.disk / g.maxdisk) * 100)} %`).join(' · '),
								fix: full.some((g) => forgeSlugs.has(g.vmid))
									? `Projets Forge : onglet Conteneur → Taille (${full.filter((g) => forgeSlugs.has(g.vmid)).map((g) => forgeSlugs.get(g.vmid)).join(', ')}). Prod : pct resize <ctid> rootfs +5G`
									: 'pct resize <ctid> rootfs +5G (sur l’hôte)'
							}
						: { id: 'ct-disks', group: 'Proxmox', label: 'Disques des CT', status: 'ok', detail: 'Tous les CT démarrés sont sous 80 % de remplissage.' };
				},
				{ id: 'ct-disks', group: 'Proxmox', label: 'Disques des CT' }
			),
			safe(
				async () => {
					const bridge = settings.get('proxmox.bridge');
					const ifaces = await proxmox.api.nodeNetworks();
					const b = ifaces.find((i) => i.iface === bridge);
					if (!b) return { id: 'bridge', group: 'Réseau', label: `Bridge « ${bridge} »`, status: 'error', detail: 'Absent de la configuration réseau du nœud.', fix: 'Ajoutez le bridge dans /etc/network/interfaces (voir docs/INSTALL.md).' };
					const gw = settings.get('network.gateway');
					const ok = b.active !== 0 && (!b.cidr || b.cidr.startsWith(`${gw}/`) || b.address === gw);
					return {
						id: 'bridge',
						group: 'Réseau',
						label: `Bridge « ${bridge} »`,
						status: ok ? 'ok' : 'warn',
						detail: `${b.cidr ?? b.address ?? 'sans adresse'}${b.active === 0 ? ' (inactif)' : ''}${ok ? '' : ` — passerelle attendue ${gw}`}.`
					};
				},
				{ id: 'bridge', group: 'Réseau', label: 'Bridge interne' }
			),
			safe(
				async () => {
					const ip = settings.get('network.publicIp');
					const r = await this.s.probe().http(`http://${ip}`, 5000);
					return r.status !== null
						? { id: 'public', group: 'Réseau', label: 'Ports 80/443 → NPM', status: 'ok', detail: `http://${ip} répond (HTTP ${r.status}, ${r.ms} ms).` }
						: {
								id: 'public',
								group: 'Réseau',
								label: 'Ports 80/443 → NPM',
								status: 'error',
								detail: `http://${ip} ne répond pas (${r.error ?? 'délai dépassé'}) : Let's Encrypt échouera.`,
								fix: 'Vérifiez la redirection DNAT 80/443 de l’hôte vers NPM (10.10.10.2).'
							};
				},
				{ id: 'public', group: 'Réseau', label: 'Ports 80/443 → NPM' }
			),
			safe(
				async () => {
					// CT du pool avec firewall=1 : leur NAT passe par un pont fwbr (zone conntrack requise).
					const guests = await guestsP;
					const running = repos.projects
						.list()
						.filter((p) => p.status !== 'deleted' && p.ctid && p.ip && guests.some((g) => g.vmid === p.ctid && g.pool === pool && g.status === 'running'));
					const filtered = (
						await Promise.all(
							running.map(async (p) => {
								const cfg = await proxmox.guestConfig(p.ctid as number).catch(() => ({}) as Record<string, unknown>);
								return hasFirewallFlag(String(cfg.net0 ?? '')) ? p : null;
							})
						)
					).filter((p) => p !== null);
					const base = { id: 'ct-internet', group: 'Réseau', label: 'Accès Internet des CT avec pare-feu' };
					if (filtered.length === 0) return { ...base, status: 'info', detail: 'Aucun CT de projet démarré avec le pare-feu Proxmox (firewall=1).' };
					const results = await Promise.all(
						filtered.map(async (p) => {
							const r = await this.s.shell.read({ ip: p.ip as string, sshHostKey: p.sshHostKey }, ReadCommand.internet()).catch(() => null);
							return { p, probe: r ? parseInternetProbe(r.code, r.stdout) : null };
						})
					);
					const down = results.filter((r) => r.probe === 'down');
					const unreachable = results.filter((r) => r.probe === null);
					if (down.length) {
						return {
							...base,
							status: 'error',
							detail: `Sans Internet (${INTERNET_PROBE_URL}) : ${down.map((r) => `${r.p.slug} (CT ${r.p.ctid})`).join(', ')}. Le runner ne peut plus joindre GitHub.`,
							fix: `${CONNTRACK_FIX} (zone conntrack des ponts fwbr, sur l’hôte)`
						};
					}
					return {
						...base,
						status: unreachable.length ? 'warn' : 'ok',
						detail: `${results.length - unreachable.length}/${results.length} CT joignent ${INTERNET_PROBE_URL}.${unreachable.length ? ` SSH impossible vers : ${unreachable.map((r) => r.p.slug).join(', ')}.` : ''}`
					};
				},
				{ id: 'ct-internet', group: 'Réseau', label: 'Accès Internet des CT avec pare-feu' }
			),
			safe(
				async () => {
					const h = await this.s.proxy.api.health();
					return { id: 'npm', group: 'Services', label: 'Nginx Proxy Manager', status: h.status === 'OK' ? 'ok' : 'warn', detail: `Version ${h.version} — ${h.status}.` };
				},
				{ id: 'npm', group: 'Services', label: 'Nginx Proxy Manager', fix: 'Réglages → NPM.' }
			),
			safe(
				async () => {
					const o = await proxmox.api.clusterFirewallOptions();
					const enabled = Number(o.enable ?? 0) === 1;
					const policyIn = String(o.policy_in ?? 'DROP');
					if (!enabled) {
						return {
							id: 'fw-cluster',
							group: 'Sécurité',
							label: 'Pare-feu du datacenter',
							status: 'warn',
							detail: 'Désactivé : les CT des projets peuvent joindre les bases de données de la prod sur le bridge.',
							fix: 'bash infra/05-firewall.sh (active le pare-feu sans filtrer l’hôte : policy_in=ACCEPT au niveau datacenter).'
						};
					}
					return {
						id: 'fw-cluster',
						group: 'Sécurité',
						label: 'Pare-feu du datacenter',
						status: 'ok',
						detail: `Activé (entrée hôte : ${policyIn}).${policyIn !== 'ACCEPT' ? ' Vérifiez que les règles de l’hôte autorisent 8006/22 depuis Tailscale.' : ''}`
					};
				},
				{ id: 'fw-cluster', group: 'Sécurité', label: 'Pare-feu du datacenter' }
			),
			safe(
				async () => {
					const list = repos.projects.list().filter((p) => p.status !== 'deleted' && p.ctid);
					const guests = await guestsP;
					const rows = await Promise.all(
						list
							.filter((p) => guests.some((g) => g.vmid === p.ctid))
							.map(async (p) => {
								const st = await proxmox.firewallStatus(p.ctid as number, firewallPlan(this.s, p)).catch(() => null);
								return { slug: p.slug, name: p.name, ctid: p.ctid as number, upToDate: !!st?.upToDate };
							})
					);
					const ok = rows.filter((r) => r.upToDate).length;
					if (!settings.bool('firewall.enabled')) {
						return { id: 'fw-projects', group: 'Sécurité', label: 'Isolement des projets', status: 'info', detail: 'Pare-feu par CT désactivé dans Réglages → Réseau.', projects: rows };
					}
					return {
						id: 'fw-projects',
						group: 'Sécurité',
						label: 'Isolement des projets',
						status: rows.length === 0 || ok === rows.length ? 'ok' : 'warn',
						detail: rows.length === 0 ? 'Aucun CT de projet.' : `${ok}/${rows.length} CT de projet isolé(s) par leur pare-feu.`,
						fix: ok < rows.length ? 'Bouton « Appliquer » ci-dessous (job « Pare-feu du CT »).' : undefined,
						projects: rows
					};
				},
				{ id: 'fw-projects', group: 'Sécurité', label: 'Isolement des projets' }
			),
			safe(
				async () => {
					const guests = await guestsP;
					const leaks = guests.filter((g) => protectedIds.includes(g.vmid) && g.pool === pool);
					const forgeCt = guests.find((g) => g.tags.includes('forge-app') || g.name === 'forge');
					const out: HealthCheck[] = [
						leaks.length
							? { id: 'prod-pool', group: 'Sécurité', label: 'Prod hors du pool Forge', status: 'error', detail: `CT ${leaks.map((g) => g.vmid).join(', ')} dans le pool « ${pool} » : Forge pourrait les modifier !`, fix: `pvesh set /pools/${pool} --vms ${leaks.map((g) => g.vmid).join(',')} --delete 1` }
							: { id: 'prod-pool', group: 'Sécurité', label: 'Prod hors du pool Forge', status: 'ok', detail: `Aucun des CT ${protectedIds.join(', ')} n’est dans le pool « ${pool} ».` }
					];
					if (forgeCt) {
						out.push(
							forgeCt.pool === pool
								? { id: 'forge-pool', group: 'Sécurité', label: 'Forge hors de son propre pool', status: 'error', detail: `Le CT ${forgeCt.vmid} (Forge) est dans le pool : il pourrait se supprimer lui-même.`, fix: `pvesh set /pools/${pool} --vms ${forgeCt.vmid} --delete 1` }
								: { id: 'forge-pool', group: 'Sécurité', label: 'Forge hors de son propre pool', status: 'ok', detail: `CT ${forgeCt.vmid} hors du pool.` }
						);
					}
					return out;
				},
				{ id: 'prod-pool', group: 'Sécurité', label: 'Prod hors du pool Forge' }
			),
			safe(
				async () => {
					const jobs = await proxmox.api.backupJobs();
					const guests = await guestsP;
					const prod = guests.filter((g) => protectedIds.includes(g.vmid) && !g.template).map((g) => g.vmid);
					const covered = (id: number) => jobs.some((j) => j.enabled && (j.all || (j.vmid ?? '').split(',').map(Number).includes(id)));
					const missing = prod.filter((id) => !covered(id));
					return missing.length
						? { id: 'backup-job', group: 'Sauvegardes', label: 'Sauvegarde quotidienne de la prod', status: 'warn', detail: `CT non couverts par un job de sauvegarde : ${missing.join(', ')}.`, fix: 'bash infra/01-backup-job.sh' }
						: { id: 'backup-job', group: 'Sauvegardes', label: 'Sauvegarde quotidienne de la prod', status: 'ok', detail: `${prod.length} CT couverts (${jobs.filter((j) => j.enabled).map((j) => `${j.id} : ${j.schedule}`).join(', ')}).` };
				},
				{ id: 'backup-job', group: 'Sauvegardes', label: 'Sauvegarde quotidienne de la prod', fix: 'bash infra/01-backup-job.sh' }
			),
			safe(
				async () => {
					const guests = await guestsP;
					const prod = guests.filter((g) => protectedIds.includes(g.vmid) && !g.template && g.status === 'running');
					const ages = await Promise.all(prod.map(async (g) => ({ vmid: g.vmid, last: (await proxmox.listBackups(g.vmid))[0]?.ctime ?? null })));
					const stale = ages.filter((a) => !a.last || Date.now() / 1000 - a.last > 36 * 3600);
					const oldest = Math.min(...ages.map((a) => a.last ?? 0));
					return stale.length
						? { id: 'backup-recent', group: 'Sauvegardes', label: 'Sauvegardes récentes', status: 'warn', detail: `Pas de sauvegarde depuis plus de 36 h : CT ${stale.map((a) => a.vmid).join(', ')}.`, fix: 'vzdump <ctid> --storage local --mode snapshot --compress zstd' }
						: { id: 'backup-recent', group: 'Sauvegardes', label: 'Sauvegardes récentes', status: 'ok', detail: prod.length ? `Toutes de moins de 36 h (la plus ancienne : il y a ${Math.round((Date.now() / 1000 - oldest) / 3600)} h).` : 'Aucun CT de prod en marche.' };
				},
				{ id: 'backup-recent', group: 'Sauvegardes', label: 'Sauvegardes récentes' }
			),
			safe(
				async () => {
					const out: HealthCheck[] = [];
					out.push(
						settings.has('ssh.privateKey')
							? { id: 'ssh', group: 'Accès', label: 'Clé SSH de Forge', status: 'ok', detail: 'Générée (installée dans le template 900 par le script 03).' }
							: { id: 'ssh', group: 'Accès', label: 'Clé SSH de Forge', status: 'error', detail: 'Aucune clé : Forge ne peut pas configurer les CT.', fix: 'Réglages → Clé SSH → Générer, puis infra/03-template-docker-runner.sh.' }
					);
					if (clientIp) {
						const viaTailscale = inCidr(clientIp, '100.64.0.0/10') || clientIp === settings.get('network.gateway');
						const local = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp.startsWith('::ffff:127.');
						out.push({
							id: 'tailscale',
							group: 'Accès',
							label: 'Accès à Forge',
							status: viaTailscale || local ? 'ok' : 'warn',
							detail: viaTailscale
								? `Via Tailscale (${clientIp}${clientIp === settings.get('network.gateway') ? ', routé par l’hôte' : ''}).`
								: local
									? 'Connexion locale.'
									: `Depuis ${clientIp} : hors Tailscale. Vérifiez FORGE_ALLOWED_SOURCES et le pare-feu du CT 150.`
						});
					}
					out.push({
						id: 'dry-run',
						group: 'Accès',
						label: 'Mode d’écriture',
						status: 'info',
						detail: this.s.guard.isDryRun() ? 'DRY-RUN : aucune écriture réelle.' : 'Écritures réelles activées.'
					});
					return out;
				},
				{ id: 'ssh', group: 'Accès', label: 'Accès' }
			)
		]);
		return { checks: groups.flat(), checkedAt: Date.now() };
	}

	/** (Ré)applique le pare-feu des projets qui ne sont pas à jour (un job par projet). */
	async applyFirewalls(enqueue: (projectId: number) => number): Promise<number[]> {
		const { proxmox, repos } = this.s;
		const guests = await proxmox.guests();
		const ids: number[] = [];
		for (const p of repos.projects.list().filter((x) => x.status !== 'deleted' && x.ctid && guests.some((g) => g.vmid === x.ctid))) {
			if (repos.jobs.activeForProject(p.id)) continue;
			const st = await proxmox.firewallStatus(p.ctid as number, firewallPlan(this.s, p)).catch(() => null);
			if (!st?.upToDate) ids.push(enqueue(p.id));
		}
		return ids;
	}
}

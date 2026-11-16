/**
 * Page « Santé du serveur » : contrôles en LECTURE SEULE de tout ce dont Forge dépend
 * (hôte Proxmox, réseau, pare-feu, sauvegardes, NPM, accès Tailscale). Pour chaque point
 * manquant, la commande ou le script à lancer soi-même sur l'hôte.
 */
import { errorMessage } from '$lib/domain/errors';
import { committedMemoryMb, hostMemoryInUse, MAX_MEMORY_COMMIT_RATIO } from '$lib/domain/sizes';
import { BUILD_CACHE_AUTO_PRUNE_BYTES, formatBytes, parseBuildCacheUsage } from '$lib/domain/build-cache';
import type { ProjectRow } from '$server/infrastructure/db/schema';
import { hasFirewallFlag, INTERNET_PROBE_URL, parseInternetProbe } from '$lib/domain/firewall';
import { inCidr } from '$lib/domain/network';
import type { OffsiteBackupService } from './offsite';
import { backupJobChanges, CPU_WEIGHTS, criticalCtPlan, desiredBackupJobs, FORGE_BACKUP_STORAGE } from '$lib/domain/host-maintenance';
import { ReadCommand } from '../gateways';
import { CONNTRACK_FIX } from '../jobs/steps/common';
import type { ForgeServices } from '../services';
import { firewallPlan } from '../jobs/steps/firewall';
import { poolAuditFix } from './connections';

/** Plafond des journaux systemd d'un CT de projet (idempotent : ne redémarre journald que si besoin). */
export interface GuestMemory {
	vmid: number;
	name: string;
	slug: string | null;
	used: number;
	max: number;
}

const JOURNALD_CAP_COMMAND =
	"f=/etc/systemd/journald.conf.d/forge.conf; c='[Journal]\\nSystemMaxUse=50M\\n'; [ \"$(cat $f 2>/dev/null)\" = \"$(printf \"$c\")\" ] || { mkdir -p /etc/systemd/journald.conf.d && printf \"$c\" > $f && systemctl restart systemd-journald; }";

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
	/** Caches de build par projet, avec bouton de nettoyage. */
	caches?: { slug: string; ctid: number; bytes: number }[];
}

/** Réglages de l'hôte qui exigent root (cache ZFS, swap, stockage des sauvegardes) : faits par l'installeur. */
const HOST_TUNING_FIX = 'bash infra/bootstrap.sh';
/** Sauvegardes : Forge crée et corrige ses jobs lui-même (toutes les 6 h ou bouton ci-dessous). */
const AUTO_BACKUP_FIX = 'Forge corrige seul (entretien toutes les 6 h) — ou bouton « Entretenir maintenant ». Si ça échoue (droits) : bash infra/bootstrap.sh.';

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
	constructor(
		private readonly s: ForgeServices,
		private readonly offsite?: Pick<OffsiteBackupService, 'configured' | 'state'>
	) {}

	/** Sauvegardes hors serveur : configurées, récentes, testées. */
	#offsiteChecks(): HealthCheck[] {
		const base = { group: 'Sauvegardes' };
		const fix = 'Réglages → Sauvegardes R2 (bucket + clé), puis « Sauvegarder maintenant ».';
		if (!this.offsite?.configured()) {
			return [{ ...base, id: 'offsite', label: 'Copie hors serveur (R2)', status: 'warn', detail: 'Non configurée : si le disque du serveur meurt, la base de Forge et celles des projets sont perdues.', fix }];
		}
		const st = this.offsite.state();
		const age = (at?: number) => (at ? Math.round((Date.now() - at) / 3600_000) : null);
		const out: HealthCheck[] = [];
		const forge = st.forge;
		out.push(
			!forge || !forge.ok || (age(forge.at) ?? 99) > 3
				? { ...base, id: 'offsite', label: 'Copie hors serveur (R2)', status: forge && !forge.ok ? 'error' : 'warn', detail: forge?.error ? `Dernier essai en échec : ${forge.error}` : 'Base de Forge pas copiée depuis plus de 3 h.', fix }
				: { ...base, id: 'offsite', label: 'Copie hors serveur (R2)', status: 'ok', detail: `Base de Forge copiée il y a ${age(forge.at)} h${forge.simulated ? ' (DRY_RUN : rien envoyé)' : ''} ; bases des projets : ${st.projects ? (st.projects.ok ? `il y a ${age(st.projects.at)} h` : st.projects.error) : 'pas encore'}.` }
		);
		const rt = st.restoreTest;
		out.push(
			!rt
				? { ...base, id: 'offsite-test', label: 'Test de restauration', status: 'warn', detail: 'Pas encore fait (automatique, après la première copie).' }
				: rt.ok && (age(rt.at) ?? 9999) < 24 * 35
					? { ...base, id: 'offsite-test', label: 'Test de restauration', status: 'ok', detail: `Réussi le ${new Date(rt.at).toLocaleDateString('fr-FR')} : les copies se relisent.` }
					: { ...base, id: 'offsite-test', label: 'Test de restauration', status: 'error', detail: rt.ok ? 'Plus vieux que 35 jours.' : `Échec : ${rt.error}`, fix }
		);
		return out;
	}

	async run(clientIp: string | null): Promise<{ checks: HealthCheck[]; checkedAt: number; memory: GuestMemory[] }> {
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
					// Le cache ZFS (ARC) compte comme libre : il se vide dès qu'un processus a besoin de RAM.
					const free = n.memory.total - hostMemoryInUse(n.memory);
					const freePct = (free / n.memory.total) * 100;
					const ram: HealthCheck = {
						id: 'ram',
						group: 'Proxmox',
						label: 'Mémoire de l’hôte',
						status: freePct < 10 ? 'error' : freePct < 20 ? 'warn' : 'ok',
						detail: `${(free / GiB).toFixed(1)} Go libres sur ${(n.memory.total / GiB).toFixed(1)} Go (${Math.round(freePct)} %)${n.memory.arc > 0 ? `, cache ZFS de ${(n.memory.arc / GiB).toFixed(1)} Go compris` : ''}.`,
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
					const n = await proxmox.nodeStatus();
					const out: HealthCheck[] = [];
					const totalMb = n.memory.total / 1024 ** 2;
					// Limites promises aux CT démarrés vs RAM réelle.
					const guests = (await guestsP).filter((g) => g.status === 'running' && !g.template);
					const committed = committedMemoryMb(guests);
					const ratio = committed / totalMb;
					const top = [...guests].sort((a, b) => b.maxmem - a.maxmem).slice(0, 4);
					out.push({
						id: 'ram-commit',
						group: 'Capacité',
						label: 'RAM promise aux CT',
						status: ratio > 1.5 ? 'error' : ratio > MAX_MEMORY_COMMIT_RATIO ? 'warn' : 'ok',
						detail: `${(committed / 1024).toFixed(1)} Go de limites pour ${(totalMb / 1024).toFixed(1)} Go de RAM (${Math.round(ratio * 100)} %). Plus gros : ${top.map((g) => `CT ${g.vmid} ${(g.maxmem / 1024 ** 3).toFixed(1)} Go`).join(', ')}.`,
						fix:
							ratio > MAX_MEMORY_COMMIT_RATIO
								? `Au-delà de ${Math.round(MAX_MEMORY_COMMIT_RATIO * 100)} %, des builds simultanés font swapper l'hôte et ralentissent TOUS les sites. Forge demande désormais confirmation avant d'en ajouter ; réduisez les projets surdimensionnés (onglet Conteneur → Taille).`
								: undefined
					});
					// CT à leur limite : ils swappent et ralentissent (sans planter).
					const choking = guests.filter((g) => g.maxmem > 0 && g.mem / g.maxmem >= 0.9);
					const forgeSlugs = new Map(repos.projects.list().filter((p) => p.ctid && p.status !== 'deleted').map((p) => [p.ctid as number, p.slug]));
					out.push(
						choking.length
							? {
									id: 'ct-memory',
									group: 'Capacité',
									label: 'CT à court de RAM',
									status: choking.some((g) => protectedIds.includes(g.vmid)) ? 'error' : 'warn',
									detail: choking.map((g) => `CT ${g.vmid} ${g.name} : ${Math.round(g.mem / 1024 ** 2)}/${Math.round(g.maxmem / 1024 ** 2)} Mo`).join(' · '),
									fix: choking.some((g) => forgeSlugs.has(g.vmid))
										? `Projets Forge : onglet Conteneur → Taille (${choking.filter((g) => forgeSlugs.has(g.vmid)).map((g) => forgeSlugs.get(g.vmid)).join(', ')}). Autres CT : pct set <ctid> --memory <Mo>`
										: 'pct set <ctid> --memory <Mo> (sur l’hôte, appliqué à chaud)'
								}
							: { id: 'ct-memory', group: 'Capacité', label: 'CT à court de RAM', status: 'ok', detail: 'Aucun CT démarré au-delà de 90 % de sa limite.' }
					);
					// Swap de l'hôte : plein = l'hôte n'a plus de marge, tout ralentit.
					const swapPct = n.swap.total > 0 ? (n.swap.used / n.swap.total) * 100 : 0;
					out.push({
						id: 'swap',
						group: 'Capacité',
						label: 'Swap de l’hôte',
						status: n.swap.total === 0 ? 'info' : swapPct > 80 ? 'error' : swapPct > 50 ? 'warn' : 'ok',
						detail:
							n.swap.total === 0
								? 'Aucun swap.'
								: `${(n.swap.used / 1024 ** 3).toFixed(1)} Go utilisés sur ${(n.swap.total / 1024 ** 3).toFixed(1)} Go (${Math.round(swapPct)} %).${swapPct > 50 ? ' Le script ci-dessous plafonne le cache ZFS et limite le swap (une seule fois par serveur).' : ''}`,
						fix: swapPct > 50 ? HOST_TUNING_FIX : undefined
					});
					return out;
				},
				{ id: 'ram-commit', group: 'Capacité', label: 'RAM promise aux CT' }
			),
			safe(
				async () => {
					const rows = await this.buildCaches(await guestsP);
					const total = rows.reduce((s, r) => s + r.bytes, 0);
					const big = rows.filter((r) => r.bytes > BUILD_CACHE_AUTO_PRUNE_BYTES);
					return {
						id: 'build-cache',
						group: 'Capacité',
						label: 'Caches de build Docker',
						status: rows.length === 0 ? 'info' : big.length ? 'warn' : 'ok',
						detail: rows.length
							? `${formatBytes(total)} au total sur ${rows.length} CT. Forge les ramène automatiquement à 2 Go toutes les 6 h ; vider complètement ralentit seulement le prochain build.`
							: 'Aucun CT de projet démarré joignable.',
						caches: rows
					};
				},
				{ id: 'build-cache', group: 'Capacité', label: 'Caches de build Docker' }
			),
			safe(
				async () => {
					const bridge = settings.get('proxmox.bridge');
					const ifaces = await proxmox.api.nodeNetworks();
					const b = ifaces.find((i) => i.iface === bridge);
					if (!b) return { id: 'bridge', group: 'Réseau', label: `Bridge « ${bridge} »`, status: 'error', detail: 'Absent de la configuration réseau du nœud.', fix: 'bash infra/00a-network.sh (bridge nat, NAT sortant, 80/443 → NPM).' };
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
					if (r.status === null) {
						// Sans NAT « en épingle », l'IP publique est injoignable depuis le bridge : on teste NPM en direct.
						const npm = await this.s.probe().http(`http://${settings.get('network.npmIp')}`, 5000);
						if (npm.status !== null) {
							return {
								id: 'public',
								group: 'Réseau',
								label: 'Ports 80/443 → NPM',
								status: 'info',
								detail: `NPM répond en direct (HTTP ${npm.status}). http://${ip} n'est pas joignable depuis le bridge (pas de NAT en épingle) : testez-le depuis l'extérieur.`
							};
						}
					}
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
						? { id: 'backup-job', group: 'Sauvegardes', label: 'Sauvegarde quotidienne de la prod', status: 'warn', detail: `CT non couverts par un job de sauvegarde : ${missing.join(', ')}.`, fix: AUTO_BACKUP_FIX }
						: { id: 'backup-job', group: 'Sauvegardes', label: 'Sauvegarde quotidienne de la prod', status: 'ok', detail: `${prod.length} CT couverts (${jobs.filter((j) => j.enabled).map((j) => `${j.id} : ${j.schedule}`).join(', ')}).` };
				},
				{ id: 'backup-job', group: 'Sauvegardes', label: 'Sauvegarde quotidienne de la prod', fix: AUTO_BACKUP_FIX }
			),
			safe(
				async () => {
					const guests = await guestsP;
					const prod = guests.filter((g) => protectedIds.includes(g.vmid) && !g.template && g.status === 'running');
					const ages = await Promise.all(prod.map(async (g) => ({ vmid: g.vmid, last: (await proxmox.listBackups(g.vmid))[0]?.ctime ?? null })));
					const stale = ages.filter((a) => !a.last || Date.now() / 1000 - a.last > 36 * 3600);
					const oldest = Math.min(...ages.map((a) => a.last ?? 0));
					return stale.length
						? { id: 'backup-recent', group: 'Sauvegardes', label: 'Sauvegardes récentes', status: 'warn', detail: `Pas de sauvegarde depuis plus de 36 h : CT ${stale.map((a) => a.vmid).join(', ')}.`, fix: `Le job de sauvegarde de Forge tourne chaque nuit (stockage ${FORGE_BACKUP_STORAGE}) ; si ça persiste, consultez Proxmox → Tâches.` }
						: { id: 'backup-recent', group: 'Sauvegardes', label: 'Sauvegardes récentes', status: 'ok', detail: prod.length ? `Toutes de moins de 36 h (la plus ancienne : il y a ${Math.round((Date.now() / 1000 - oldest) / 3600)} h).` : 'Aucun CT de prod en marche.' };
				},
				{ id: 'backup-recent', group: 'Sauvegardes', label: 'Sauvegardes récentes' }
			),
			safe(
				async () => {
					const jobs = (await proxmox.api.backupJobs()).filter((j) => j.enabled);
					const guests = await guestsP;
					const projects = repos.projects.list().filter((p) => p.status !== 'deleted' && p.ctid && guests.some((g) => g.vmid === p.ctid));
					const poolJob = jobs.find((j) => j.pool === pool);
					const covered = (ctid: number) =>
						jobs.some((j) => j.all || (j.vmid ?? '').split(',').map(Number).includes(ctid) || (j.pool !== null && guests.some((g) => g.vmid === ctid && g.pool === j.pool)));
					const missing = projects.filter((p) => !covered(p.ctid as number));
					const base = { id: 'backup-projects', group: 'Sauvegardes', label: 'Sauvegarde quotidienne des projets' };
					if (missing.length) {
						return { ...base, status: 'warn', detail: `Projets sans sauvegarde du CT : ${missing.map((p) => `${p.slug} (CT ${p.ctid})`).join(', ')}.`, fix: AUTO_BACKUP_FIX };
					}
					return {
						...base,
						status: 'ok',
						detail: poolJob
							? `Job « ${poolJob.id} » (${poolJob.schedule}) : tout le pool « ${pool} », les nouveaux projets sont inclus automatiquement.`
							: `${projects.length} projet(s) couverts. Le job par pool sera créé par Forge au prochain entretien.`
					};
				},
				{ id: 'backup-projects', group: 'Sauvegardes', label: 'Sauvegarde quotidienne des projets' }
			),
			safe(async () => this.#offsiteChecks(), { id: 'offsite', group: 'Sauvegardes', label: 'Copie hors serveur (R2)' }),
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
		// RAM réellement utilisée par chaque CT allumé, du plus gourmand au moins gourmand.
		const slugs = new Map(repos.projects.list().filter((p) => p.ctid).map((p) => [p.ctid as number, p.slug]));
		const memory: GuestMemory[] = (await guestsP.catch(() => []))
			.filter((g) => g.status === 'running' && !g.template)
			.map((g) => ({ vmid: g.vmid, name: g.name, slug: slugs.get(g.vmid) ?? null, used: g.mem, max: g.maxmem }))
			.sort((a, b) => b.used - a.used);
		return { checks: groups.flat(), checkedAt: Date.now(), memory };
	}

	/** Projets dont le CT tourne et répond en SSH. */
	#runningProjects(guests: { vmid: number; status: string }[]): ProjectRow[] {
		return this.s.repos.projects.list().filter((p) => p.status !== 'deleted' && p.ctid && p.ip && guests.some((g) => g.vmid === p.ctid && g.status === 'running'));
	}

	/** Taille du cache de build de chaque projet démarré (lecture seule). */
	async buildCaches(guests?: { vmid: number; status: string }[]): Promise<{ slug: string; ctid: number; bytes: number }[]> {
		const list = this.#runningProjects(guests ?? (await this.s.proxmox.guests()));
		const rows = await Promise.all(
			list.map(async (p) => {
				const r = await this.s.shell.read({ ip: p.ip as string, sshHostKey: p.sshHostKey }, ReadCommand.buildCache()).catch(() => null);
				return r && r.code === 0 ? { slug: p.slug, ctid: p.ctid as number, bytes: parseBuildCacheUsage(r.stdout).buildCacheBytes } : null;
			})
		);
		return rows.filter((r) => r !== null).sort((a, b) => b.bytes - a.bytes);
	}

	/** Vide le cache de build des projets choisis (un job par projet ; ceux déjà occupés sont sautés). */
	pruneCaches(slugs: string[], enqueue: (projectId: number) => number): number[] {
		const ids: number[] = [];
		for (const p of this.s.repos.projects.list().filter((x) => slugs.includes(x.slug) && x.status !== 'deleted' && x.ctid)) {
			if (this.s.repos.jobs.activeForProject(p.id)) continue;
			ids.push(enqueue(p.id));
		}
		return ids;
	}

	/**
	 * Nettoyage automatique (minuterie) : les CT dont le cache dépasse 2 Go sont ramenés
	 * à 2 Go en gardant les couches récentes. Passe par la garde d'écriture (DRY_RUN respecté).
	 */
	async autoPruneCaches(enqueue: (projectId: number) => number): Promise<string[]> {
		const big = (await this.buildCaches()).filter((r) => r.bytes > BUILD_CACHE_AUTO_PRUNE_BYTES);
		const slugs = big.map((r) => r.slug);
		this.pruneCaches(slugs, enqueue);
		return slugs;
	}

	/**
	 * Entretien automatique (minuterie, et bouton de la page Santé) : jobs de sauvegarde
	 * « forge-* », réglages des CT critiques (NPM, Forge) et priorité CPU des projets.
	 * Chaque écriture passe par la garde (DRY_RUN respecté). Renvoie ce qui a été fait / raté.
	 */
	async autoMaintain(): Promise<{ done: string[]; failed: string[] }> {
		const { proxmox, repos, settings } = this.s;
		const done: string[] = [];
		const failed: string[] = [];
		const attempt = async (label: string, fn: () => Promise<unknown>) => {
			try {
				await fn();
				done.push(label);
			} catch (err) {
				failed.push(`${label} : ${errorMessage(err)}`);
			}
		};
		const guests = await proxmox.api.guests();
		const exists = (id: number) => guests.some((g) => g.vmid === id && !g.template && g.type === 'lxc');
		const critical = settings.criticalCtids().filter(exists);

		// 1. Sauvegardes : NPM + Forge chaque nuit, et tout le pool des projets (nouveaux inclus).
		const desired = desiredBackupJobs({ criticalCtids: critical, pool: settings.get('proxmox.pool') });
		for (const c of backupJobChanges(await proxmox.backupJobs(), desired)) {
			await attempt(`job de sauvegarde ${c.job.id}`, () => proxmox.upsertBackupJob(c.job, c.exists));
		}

		// 2. CT critiques : priorité CPU haute, RAM au plancher s'ils étouffent.
		const node = await proxmox.nodeStatus();
		let hostAvailableMb = Math.round((node.memory.total - hostMemoryInUse(node.memory)) / 1048576);
		for (const id of critical) {
			const g = guests.find((x) => x.vmid === id)!;
			const cfg = await proxmox.guestConfig(id);
			const plan = criticalCtPlan({
				memoryMb: Number(cfg.memory ?? Math.round(g.maxmem / 1048576)),
				usedMb: Math.round(g.mem / 1048576),
				cpuunits: cfg.cpuunits === undefined ? null : Number(cfg.cpuunits),
				hostAvailableMb
			});
			if (!Object.keys(plan).length) continue;
			await attempt(`CT ${id} (${g.name}) ${Object.entries(plan).map(([k, v]) => `${k}=${v}`).join(', ')}`, () => proxmox.tuneCriticalCt(id, plan));
			if (plan.memory) hostAvailableMb -= plan.memory - Number(cfg.memory ?? 0);
		}

		// 3. Projets : la prod passe avant la dev quand le processeur sature.
		for (const p of repos.projects.list().filter((x) => x.status !== 'deleted' && x.ctid && exists(x.ctid))) {
			if (repos.jobs.activeForProject(p.id)) continue;
			const want = CPU_WEIGHTS[p.environment];
			const cfg = await proxmox.guestConfig(p.ctid as number).catch(() => null);
			if (!cfg || Number(cfg.cpuunits ?? 100) === want) continue;
			await attempt(`priorité CPU de ${p.slug} = ${want}`, () => proxmox.configure(p.ctid as number, { cpuunits: want }));
		}

		// 4. Journaux système des projets plafonnés à 50 Mo (une fois par CT et par démarrage de Forge).
		const running = new Set(guests.filter((g) => g.status === 'running').map((g) => g.vmid));
		for (const p of repos.projects.list().filter((x) => x.status === 'active' && x.ctid && x.ip && running.has(x.ctid) && !this.#journaldDone.has(x.id))) {
			if (repos.jobs.activeForProject(p.id)) continue;
			await attempt(`journaux de ${p.slug} plafonnés à 50 Mo`, async () => {
				await this.s.shell.run({ ip: p.ip!, sshHostKey: p.sshHostKey }, 'root', JOURNALD_CAP_COMMAND, { summary: 'Journaux système plafonnés à 50 Mo' });
				this.#journaldDone.add(p.id);
			});
		}
		return { done, failed };
	}

	readonly #journaldDone = new Set<number>();

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

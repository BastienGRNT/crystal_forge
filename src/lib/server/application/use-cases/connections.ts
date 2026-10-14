/**
 * « Tester les connexions » : lectures seules sur chaque API, vérification des
 * permissions, et preuve que Forge n'a AUCUN droit d'écriture sur les CT de prod.
 */
import { errorMessage } from '$lib/domain/errors';
import { dangerousOvhRules } from '$server/infrastructure/clients/ovh-signature';
import { publicKeyFingerprint } from '$server/infrastructure/clients/ssh';
import type { ForgeServices } from '../services';

export type CheckStatus = 'ok' | 'warn' | 'error' | 'skipped';

export interface CheckItem {
	label: string;
	status: CheckStatus;
	detail: string;
}

export interface CheckSection {
	id: 'proxmox' | 'github' | 'ovh' | 'npm' | 'ssh' | 'dns';
	label: string;
	status: CheckStatus;
	summary: string;
	items: CheckItem[];
	ms: number;
}

export interface PermissionRow {
	vmid: number;
	name: string;
	pool: string | null;
	expected: 'write' | 'read';
	canWrite: boolean;
	privileges: string[];
	ok: boolean;
}

const WRITE_PRIVS = ['VM.Allocate', 'VM.PowerMgmt', 'VM.Config.Options', 'VM.Config.Disk', 'VM.Config.Network', 'VM.Config.CPU', 'VM.Config.Memory', 'VM.Backup', 'VM.Clone', 'VM.Snapshot'];

function worst(items: CheckItem[]): CheckStatus {
	if (items.some((i) => i.status === 'error')) return 'error';
	if (items.some((i) => i.status === 'warn')) return 'warn';
	if (items.length && items.every((i) => i.status === 'skipped')) return 'skipped';
	return 'ok';
}

async function timed(id: CheckSection['id'], label: string, fn: (items: CheckItem[]) => Promise<string>): Promise<CheckSection> {
	const t0 = Date.now();
	const items: CheckItem[] = [];
	let summary = '';
	try {
		summary = await fn(items);
	} catch (err) {
		items.push({ label: 'Connexion', status: 'error', detail: errorMessage(err) });
		summary = 'Échec';
	}
	return { id, label, status: worst(items), summary, items, ms: Date.now() - t0 };
}

export class ConnectionTester {
	constructor(private readonly s: ForgeServices) {}

	async run(): Promise<{ sections: CheckSection[]; permissions: PermissionRow[]; checkedAt: number }> {
		const permissions: PermissionRow[] = [];
		const sections = await Promise.all([
			timed('proxmox', 'Proxmox VE', (items) => this.#proxmox(items, permissions)),
			timed('github', 'GitHub', (items) => this.#github(items)),
			timed('ovh', 'OVH (DNS)', (items) => this.#ovh(items)),
			timed('npm', 'Nginx Proxy Manager', (items) => this.#npm(items)),
			timed('ssh', 'Clé SSH', (items) => this.#ssh(items)),
			timed('dns', 'DNS public (DoH)', (items) => this.#doh(items))
		]);
		return { sections, permissions, checkedAt: Date.now() };
	}

	async #proxmox(items: CheckItem[], permissions: PermissionRow[]): Promise<string> {
		const { proxmox, settings } = this.s;
		if (!settings.has('proxmox.tokenSecret') && this.s.config.mode !== 'mock') {
			items.push({ label: 'Jeton API', status: 'skipped', detail: 'Non configuré' });
			return 'Non configuré';
		}
		const v = await proxmox.version();
		items.push({ label: 'API', status: 'ok', detail: `Proxmox VE ${v.version} — ${settings.get('proxmox.url')}` });
		items.push(
			settings.get('proxmox.caCert').trim() || this.s.config.mode === 'mock'
				? { label: 'TLS', status: 'ok', detail: 'Certificat vérifié avec le CA de Proxmox' }
				: { label: 'TLS', status: 'warn', detail: 'Certificat non vérifié : collez pve-root-ca.pem dans les réglages' }
		);
		const node = await proxmox.nodeStatus();
		items.push({
			label: 'Nœud',
			status: 'ok',
			detail: `${settings.get('proxmox.node')} — ${node.cpus} cœurs, ${(node.memory.free / 1024 ** 3).toFixed(1)} Go de RAM libres sur ${(node.memory.total / 1024 ** 3).toFixed(1)}`
		});

		const guests = await proxmox.guests();
		const pool = settings.get('proxmox.pool');
		const templateId = settings.int('proxmox.templateId');
		const tpl = guests.find((g) => g.vmid === templateId);
		items.push(
			!tpl
				? { label: `Template ${templateId}`, status: 'error', detail: 'Introuvable : lancez infra/03-template-docker-runner.sh' }
				: !tpl.template
					? { label: `Template ${templateId}`, status: 'error', detail: `Le CT ${templateId} existe mais n'est pas un template` }
					: tpl.pool !== pool
						? { label: `Template ${templateId}`, status: 'error', detail: `Hors du pool « ${pool} » : Forge ne pourra pas le cloner` }
						: { label: `Template ${templateId}`, status: 'ok', detail: `${tpl.name}, dans le pool « ${pool} »` }
		);

		const all = await proxmox.permissions();
		const has = (path: string, priv: string) => !!all[path]?.[priv];
		const req = async (path: string, privs: string[], label: string) => {
			const p = all[path] ?? (await proxmox.permissions(path))[path] ?? {};
			const missing = privs.filter((x) => !p[x]);
			items.push(
				missing.length
					? { label, status: 'error', detail: `${path} : manque ${missing.join(', ')}` }
					: { label, status: 'ok', detail: `${path} : ${privs.join(', ')}` }
			);
		};
		await req(`/pool/${pool}`, ['VM.Allocate', 'VM.Clone', 'VM.Config.Network', 'VM.PowerMgmt'], 'Droits sur le pool');
		await req(`/storage/${settings.get('proxmox.storage')}`, ['Datastore.AllocateSpace'], 'Droits sur le stockage');
		await req(`/sdn/zones/localnetwork/${settings.get('proxmox.bridge')}`, ['SDN.Use'], 'Droits sur le bridge');
		const vmbr0 = (await proxmox.permissions('/sdn/zones/localnetwork/vmbr0'))['/sdn/zones/localnetwork/vmbr0'] ?? {};
		items.push(
			vmbr0['SDN.Use']
				? { label: 'Bridge public vmbr0', status: 'warn', detail: 'Le jeton peut utiliser vmbr0 : restreignez SDN.Use au bridge nat' }
				: { label: 'Bridge public vmbr0', status: 'ok', detail: 'Interdit (SDN.Use absent)' }
		);
		if (has('/', 'Sys.Modify') || has('/', 'Permissions.Modify') || has('/access', 'User.Modify')) {
			items.push({ label: 'Privilèges globaux', status: 'error', detail: 'Le jeton a des droits d’administration globaux : beaucoup trop large' });
		}

		// Matrice CT par CT : la preuve que la prod est intouchable.
		const protectedIds = settings.safetyContext().protectedCtids;
		for (const g of guests) {
			const perms = all[`/vms/${g.vmid}`] ?? (await proxmox.permissions(`/vms/${g.vmid}`))[`/vms/${g.vmid}`] ?? {};
			const writePrivs = WRITE_PRIVS.filter((p) => perms[p]);
			const expected: PermissionRow['expected'] = g.pool === pool && !protectedIds.includes(g.vmid) ? 'write' : 'read';
			const canWrite = writePrivs.length > 0;
			permissions.push({
				vmid: g.vmid,
				name: g.name,
				pool: g.pool,
				expected,
				canWrite,
				privileges: Object.keys(perms).sort(),
				ok: expected === 'read' ? !canWrite : canWrite
			});
		}
		const leaks = permissions.filter((p) => p.expected === 'read' && p.canWrite);
		items.push(
			leaks.length
				? { label: 'CT de production', status: 'error', detail: `DANGER : droits d'écriture sur ${leaks.map((l) => l.vmid).join(', ')}` }
				: {
						label: 'CT de production',
						status: 'ok',
						detail: `Aucun droit d'écriture sur ${permissions.filter((p) => p.expected === 'read').map((p) => p.vmid).join(', ')}`
					}
		);
		return `PVE ${v.version}, ${guests.length} invités`;
	}

	async #github(items: CheckItem[]): Promise<string> {
		const { github, settings } = this.s;
		if (!settings.has('github.token') && this.s.config.mode !== 'mock') {
			items.push({ label: 'Jeton', status: 'skipped', detail: 'Non configuré' });
			return 'Non configuré';
		}
		const me = await github.api.whoami();
		const owner = settings.get('github.owner');
		items.push(
			me.login.toLowerCase() === owner.toLowerCase()
				? { label: 'Compte', status: 'ok', detail: `Connecté en tant que ${me.login}` }
				: { label: 'Compte', status: 'warn', detail: `Connecté en tant que ${me.login}, propriétaire attendu : ${owner}` }
		);
		if (me.tokenExpiresAt) {
			const days = Math.round((Date.parse(me.tokenExpiresAt) - Date.now()) / 86400_000);
			items.push({ label: 'Expiration du jeton', status: days < 14 ? 'warn' : 'ok', detail: `Dans ${days} jours (${me.tokenExpiresAt.slice(0, 10)})` });
		} else {
			items.push({ label: 'Expiration du jeton', status: 'ok', detail: 'Sans expiration' });
		}
		const repos = await github.api.listRepos();
		items.push({ label: 'Dépôts accessibles', status: repos.length ? 'ok' : 'warn', detail: `${repos.length} dépôt(s)` });
		items.push({
			label: 'Permissions',
			status: 'ok',
			detail: 'Administration, Secrets, Variables, Actions, Contents, Workflows : vérifiées à la première utilisation sur un dépôt'
		});
		return `${me.login} — ${repos.length} dépôts`;
	}

	async #ovh(items: CheckItem[]): Promise<string> {
		const { dns, settings } = this.s;
		if (!settings.has('ovh.consumerKey') && this.s.config.mode !== 'mock') {
			items.push({ label: 'Clés API', status: 'skipped', detail: 'Non configurées' });
			return 'Non configuré';
		}
		const cred = await dns.api.currentCredential();
		items.push({ label: 'Jeton', status: cred.status === 'validated' ? 'ok' : 'error', detail: `Statut : ${cred.status}${cred.expiration ? `, expire le ${cred.expiration.slice(0, 10)}` : ', sans expiration'}` });
		const danger = dangerousOvhRules(cred.rules);
		for (const d of danger) items.push({ label: 'Règle trop large', status: 'error', detail: `${d.rule.method} ${d.rule.path} : ${d.reason}` });
		const canDelete = cred.rules.some((r) => r.method === 'DELETE' && /\/record\/\*$/.test(r.path));
		items.push(
			canDelete
				? { label: 'Suppression', status: 'ok', detail: 'DELETE sur les enregistrements : rollback et retrait de domaine automatiques' }
				: { label: 'Suppression', status: 'warn', detail: 'Pas de DELETE : les enregistrements devront être supprimés à la main' }
		);
		const zones = await dns.listZones();
		items.push({ label: 'Zones', status: zones.length ? 'ok' : 'warn', detail: zones.join(', ') || 'aucune' });
		items.push({ label: 'Règles du jeton', status: 'ok', detail: cred.rules.map((r) => `${r.method} ${r.path}`).join(' · ') });
		return `${zones.length} zone(s)`;
	}

	async #npm(items: CheckItem[]): Promise<string> {
		const { proxy, settings } = this.s;
		const health = await proxy.api.health();
		items.push({ label: 'API', status: health.status === 'OK' ? 'ok' : 'warn', detail: `NPM ${health.version} — ${settings.get('npm.url')}` });
		if (!settings.has('npm.secret') && this.s.config.mode !== 'mock') {
			items.push({ label: 'Compte', status: 'skipped', detail: 'Identifiants non configurés' });
			return `NPM ${health.version}`;
		}
		const me = await proxy.api.me();
		items.push(
			me.roles.includes('admin')
				? { label: 'Compte', status: 'warn', detail: `${me.email} est administrateur NPM : préférez un compte dédié non admin` }
				: { label: 'Compte', status: 'ok', detail: `${me.name} <${me.email}>, non administrateur` }
		);
		const perms = me.permissions ?? {};
		items.push(
			perms.proxy_hosts === 'manage' && perms.certificates === 'manage'
				? { label: 'Permissions', status: 'ok', detail: `Proxy hosts : manage, certificats : manage, visibilité : ${perms.visibility}` }
				: { label: 'Permissions', status: 'error', detail: `Proxy hosts : ${perms.proxy_hosts ?? '?'}, certificats : ${perms.certificates ?? '?'} — il faut « manage » pour les deux` }
		);
		if (perms.visibility !== 'all') {
			items.push({ label: 'Visibilité', status: 'warn', detail: 'Visibilité « user » : le dashboard ne verra pas les proxy hosts de prod (NPM empêche quand même les doublons)' });
		}
		const email = settings.get('letsencrypt.email');
		items.push({
			label: "Email Let's Encrypt",
			status: 'ok',
			detail: email ? `${email} (NPM 2.16 utilise l'email du compte : ${me.email})` : `Non défini : celui du compte NPM sera utilisé (${me.email})`
		});
		const hosts = await proxy.listHosts();
		items.push({ label: 'Proxy hosts', status: 'ok', detail: `${hosts.length} visibles` });
		return `NPM ${health.version}, ${hosts.length} proxy hosts`;
	}

	async #ssh(items: CheckItem[]): Promise<string> {
		const pub = this.s.settings.get('ssh.publicKey');
		if (!pub || !this.s.settings.has('ssh.privateKey')) {
			items.push({ label: 'Clé', status: 'warn', detail: 'Aucune clé : générez-la puis passez la clé publique à infra/03-template-docker-runner.sh' });
			return 'Aucune clé';
		}
		items.push({ label: 'Clé ed25519', status: 'ok', detail: publicKeyFingerprint(pub) ?? 'empreinte illisible' });
		return 'Clé présente';
	}

	async #doh(items: CheckItem[]): Promise<string> {
		const ip = this.s.settings.get('network.publicIp');
		const ips = await this.s.resolver().resolveA('bastiengrnt.fr');
		items.push({ label: 'dns.google', status: ips.length ? 'ok' : 'warn', detail: `bastiengrnt.fr → ${ips.join(', ') || 'aucune réponse'}${ips.includes(ip) ? ' (IP publique du serveur)' : ''}` });
		return 'Résolution OK';
	}
}

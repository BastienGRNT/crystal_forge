/**
 * Réglages de Forge, stockés en base. Les valeurs secrètes sont chiffrées
 * (AES-256-GCM, AAD = clé du réglage) et ne sortent jamais vers le navigateur.
 */
import type { SafetyContext } from '$lib/domain/safety-policy';

export interface SettingsStore {
	all(): { key: string; value: string; isSecret: boolean }[];
	get(key: string): { value: string; isSecret: boolean } | undefined;
	set(key: string, value: string, isSecret: boolean): void;
	delete(key: string): void;
}

export interface Cipher {
	encrypt(plaintext: string, aad?: string): string;
	decrypt(payload: string, aad?: string): string;
}

interface Def {
	default: string;
	secret?: boolean;
}

export const SETTING_DEFS = {
	'proxmox.url': { default: 'https://10.10.10.1:8006' },
	/** Rempli par infra/02 (provision.json). */
	'proxmox.node': { default: '' },
	'proxmox.tokenId': { default: 'forge@pve!forge' },
	'proxmox.tokenSecret': { default: '', secret: true },
	'proxmox.caCert': { default: '' },
	'proxmox.pool': { default: 'forge' },
	'proxmox.templateId': { default: '900' },
	'proxmox.storage': { default: 'local' },
	'proxmox.backupStorage': { default: 'forge-backups' },
	'proxmox.bridge': { default: 'nat' },
	'network.gateway': { default: '10.10.10.1' },
	'network.cidr': { default: '24' },
	/** Obligatoire : cible des enregistrements A. */
	'network.publicIp': { default: '' },
	'network.ipStart': { default: '10.10.10.60' },
	'network.ipEnd': { default: '10.10.10.99' },
	/** Passerelle, NPM et Forge (infra/00a, 00c, 04) : à compléter avec les IP propres à l'hôte. */
	'network.reservedIps': { default: '10.10.10.1,10.10.10.2,10.10.10.15' },
	'network.npmIp': { default: '10.10.10.2' },
	'network.forgeIp': { default: '10.10.10.15' },
	/** DNS des CT de projet (IP séparées par des espaces). Vide = hérité de l'hôte. */
	'network.nameserver': { default: '' },
	/** Pare-feu Proxmox par CT de projet (isolement du bridge). */
	'firewall.enabled': { default: 'true' },
	'ctid.min': { default: '500' },
	'ctid.max': { default: '599' },
	/** Rempli par infra/02 depuis PROD_CTIDS (infra/lib.sh), la source unique. */
	'safety.protectedCtids': { default: '' },
	/** CT qui héberge Forge (rempli par infra/02) : sauvegardé et réglé comme un CT critique. */
	'safety.forgeCtid': { default: '150' },
	/** Obligatoire : seuls les dépôts de ce compte sont utilisables. */
	'github.owner': { default: '' },
	'github.token': { default: '', secret: true },
	'ovh.endpoint': { default: 'https://eu.api.ovh.com/1.0' },
	'ovh.appKey': { default: '' },
	'ovh.appSecret': { default: '', secret: true },
	'ovh.consumerKey': { default: '', secret: true },
	'npm.url': { default: 'http://10.10.10.2:81' },
	/** IP de Forge vue par NPM, pour la page de réveil des serveurs endormis (vide = détectée). */
	'sleep.wakeHost': { default: '' },
	'npm.identity': { default: '' },
	'npm.secret': { default: '', secret: true },
	'letsencrypt.email': { default: '' },
	'ssh.privateKey': { default: '', secret: true },
	'ssh.publicKey': { default: '' },
	/** Dépôt et branche de Forge lui-même (bouton « Mettre à jour Forge »). */
	'forge.updateRepo': { default: 'BastienGRNT/crystal_forge' },
	'forge.updateBranch': { default: 'main' },
	/** Correspondance CT hors Forge → dépôt GitHub (JSON { "402": "BastienGRNT/crystal_wallet" }). */
	'dashboard.repoMap': { default: '{}' },
	/**
	 * Sauvegardes hors serveur (Cloudflare R2). Le chiffrement utilise une clé dérivée de
	 * la clé maître de Forge : rien d'autre à conserver que cette clé maître.
	 */
	'offsite.endpoint': { default: '' },
	'offsite.bucket': { default: '' },
	'offsite.accessKeyId': { default: '' },
	'offsite.secretAccessKey': { default: '', secret: true },
	/** État interne (JSON) : dernières réussites/échecs. Écrit par Forge. */
	'offsite.state': { default: '{}' },
	/**
	 * CT de build (unique, créé par Forge dans la plage des projets) : construit les images de
	 * tous les projets, puis Forge les installe dans leur CT. Allumé à la demande.
	 */
	'builder.ctid': { default: '' },
	'builder.ip': { default: '' },
	'builder.hostKey': { default: '' },
	'builder.cores': { default: '4' },
	'builder.memoryMb': { default: '4096' },
	'builder.diskGb': { default: '40' },
	/** Minutes sans build avant d'éteindre le CT de build. */
	'builder.idleMin': { default: '15' },
	/** Surcharge du DRY_RUN — uniquement en mode mock. */
	'runtime.dryRun': { default: '' }
} as const satisfies Record<string, Def>;

export type SettingKey = keyof typeof SETTING_DEFS;

export function isSecretKey(key: SettingKey): boolean {
	return 'secret' in SETTING_DEFS[key] && SETTING_DEFS[key].secret === true;
}

export function isSettingKey(key: string): key is SettingKey {
	return key in SETTING_DEFS;
}

export class SettingsService {
	#cache: Map<SettingKey, string> | null = null;
	#listeners = new Set<() => void>();

	constructor(
		private readonly store: SettingsStore,
		private readonly cipher: Cipher
	) {}

	onChange(fn: () => void): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	#load(): Map<SettingKey, string> {
		if (this.#cache) return this.#cache;
		const map = new Map<SettingKey, string>();
		for (const row of this.store.all()) {
			if (!isSettingKey(row.key)) continue;
			try {
				map.set(row.key, row.isSecret ? this.cipher.decrypt(row.value, `settings:${row.key}`) : row.value);
			} catch {
				// Clé maître changée : la valeur est illisible, on la considère absente.
			}
		}
		this.#cache = map;
		return map;
	}

	get(key: SettingKey): string {
		return this.#load().get(key) ?? SETTING_DEFS[key].default;
	}

	has(key: SettingKey): boolean {
		const v = this.#load().get(key);
		return v !== undefined && v !== '';
	}

	set(values: Partial<Record<SettingKey, string>>): void {
		for (const [k, v] of Object.entries(values) as [SettingKey, string][]) {
			if (v === undefined) continue;
			const secret = isSecretKey(k);
			if (v === '' && !secret) {
				this.store.delete(k);
				continue;
			}
			if (v === '' && secret) continue; // un champ secret vide = « ne pas changer »
			this.store.set(k, secret ? this.cipher.encrypt(v, `settings:${k}`) : v, secret);
		}
		this.#cache = null;
		this.#listeners.forEach((fn) => fn());
	}

	/** Toutes les valeurs secrètes connues (pour le masqueur de logs). */
	secretValues(): string[] {
		return (Object.keys(SETTING_DEFS) as SettingKey[]).filter(isSecretKey).map((k) => this.get(k)).filter((v) => v.length >= 4);
	}

	/** Vue envoyable au navigateur : les secrets sont remplacés par un booléen « défini ». */
	publicView(): { values: Record<string, string>; secretsSet: Record<string, boolean> } {
		const values: Record<string, string> = {};
		const secretsSet: Record<string, boolean> = {};
		for (const key of Object.keys(SETTING_DEFS) as SettingKey[]) {
			if (isSecretKey(key)) secretsSet[key] = this.has(key);
			else values[key] = this.get(key);
		}
		return { values, secretsSet };
	}

	bool(key: SettingKey): boolean {
		return /^(1|true|oui|yes|on)$/i.test(this.get(key).trim());
	}

	int(key: SettingKey): number {
		const n = Number.parseInt(this.get(key), 10);
		if (!Number.isFinite(n)) throw new Error(`Réglage ${key} invalide : ${this.get(key)}`);
		return n;
	}

	list(key: SettingKey): string[] {
		return this.get(key)
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	}

	safetyContext(): SafetyContext {
		return {
			ctidRange: { min: this.int('ctid.min'), max: this.int('ctid.max') },
			ipRange: { start: this.get('network.ipStart'), end: this.get('network.ipEnd') },
			pool: this.get('proxmox.pool'),
			templateId: this.int('proxmox.templateId'),
			bridge: this.get('proxmox.bridge'),
			publicIp: this.get('network.publicIp'),
			protectedCtids: this.list('safety.protectedCtids').map(Number).filter(Number.isFinite),
			reservedIps: this.list('network.reservedIps')
		};
	}

	/** CT critiques (NPM, Forge…) : sauvegardés chaque nuit, RAM plancher et priorité CPU haute. */
	criticalCtids(): number[] {
		const ids = [...this.list('safety.protectedCtids'), this.get('safety.forgeCtid')].map(Number).filter((n) => Number.isInteger(n) && n > 0);
		return [...new Set(ids)];
	}

	repoMap(): Record<string, string> {
		try {
			const parsed: unknown = JSON.parse(this.get('dashboard.repoMap'));
			return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
		} catch {
			return {};
		}
	}
}

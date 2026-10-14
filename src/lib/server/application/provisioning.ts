/**
 * Échanges automatiques avec les scripts infra/ via le dossier partagé du CT 150
 * (/opt/forge/updates, monté sur /updates) :
 *   • forge.pub : clé publique SSH de Forge, lue par bootstrap.sh pour créer le template 900 ;
 *   • provision.json : réglages déposés par infra/02 (jeton, CA, CT de production protégés).
 *     Importés dans les réglages chiffrés puis supprimés. Seules les clés listées sont acceptées.
 */
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SettingKey, SettingsService } from './settings';

export const PROVISION_FILE = 'provision.json';
export const PUBLIC_KEY_FILE = 'forge.pub';

/** Réglages qu'un script de l'hôte peut fournir : rien d'autre n'est importé. */
const PROVISIONABLE: SettingKey[] = ['proxmox.url', 'proxmox.node', 'proxmox.tokenId', 'proxmox.tokenSecret', 'proxmox.caCert', 'safety.protectedCtids'];

async function isDir(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** Importe provision.json s'il existe. Renvoie les clés importées, ou null si aucun fichier. */
export async function importProvisioning(dir: string, settings: SettingsService): Promise<SettingKey[] | null> {
	const file = join(dir, PROVISION_FILE);
	let raw: string;
	try {
		raw = await readFile(file, 'utf8');
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		await rename(file, `${file}.invalid`).catch(() => {});
		throw new Error(`${PROVISION_FILE} illisible (renommé en ${PROVISION_FILE}.invalid).`);
	}
	const values: Partial<Record<SettingKey, string>> = {};
	if (parsed && typeof parsed === 'object') {
		for (const key of PROVISIONABLE) {
			const v = (parsed as Record<string, unknown>)[key];
			if (typeof v === 'string' && v.trim() !== '') values[key] = v.trim();
		}
	}
	// Le fichier contient un secret : supprimé avant tout le reste, même s'il ne contient rien d'utile.
	await rm(file, { force: true });
	const keys = Object.keys(values) as SettingKey[];
	if (keys.length) settings.set(values);
	return keys;
}

/** Écrit la clé publique dans le dossier partagé (si monté) quand elle a changé. */
export async function exportPublicKey(dir: string, publicKey: string): Promise<void> {
	if (!publicKey || !(await isDir(dir))) return;
	const file = join(dir, PUBLIC_KEY_FILE);
	const current = await readFile(file, 'utf8').catch(() => '');
	if (current.trim() === publicKey.trim()) return;
	await writeFile(`${file}.part`, `${publicKey.trim()}\n`, { mode: 0o644 });
	await rename(`${file}.part`, file);
}

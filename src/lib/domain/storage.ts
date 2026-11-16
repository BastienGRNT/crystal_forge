/**
 * Stockage des disques des CT.
 * « local » (dossier) range chaque disque dans un gros fichier .raw ; « forge-ct » (créé par
 * infra/09 sur le pool ZFS) donne un volume ZFS par CT : compression, instantanés, place réelle.
 */
import { SafetyViolation } from './errors';

export const FORGE_ZFS_STORAGE = 'forge-ct';

/** Stockage d'un rootfs Proxmox (« local:150/vm-150-disk-0.raw,size=8G » → « local »). */
export function rootfsStorage(rootfs: string | null | undefined): string | null {
	const m = /^([a-z][a-z0-9_.-]*):/i.exec(String(rootfs ?? ''));
	return m?.[1] ?? null;
}

/** Forge ne déplace un disque que vers SON stockage ZFS, jamais ailleurs. */
export function assertSafeVolumeMove(volume: string, storage: string): void {
	if (volume !== 'rootfs') throw new SafetyViolation('move.volume', `Seul le disque principal (rootfs) peut être déplacé, pas « ${volume} ».`);
	if (storage !== FORGE_ZFS_STORAGE) throw new SafetyViolation('move.storage', `Déplacement refusé vers « ${storage} » : seul « ${FORGE_ZFS_STORAGE} » est autorisé.`);
}

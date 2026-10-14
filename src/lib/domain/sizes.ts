export type SizeKey = 'S' | 'M' | 'L';

export interface ContainerSize {
	key: SizeKey;
	label: string;
	cores: number;
	memoryMb: number;
	swapMb: number;
	diskGb: number;
}

export const SIZES: Record<SizeKey, ContainerSize> = {
	S: { key: 'S', label: 'Petit', cores: 1, memoryMb: 1024, swapMb: 512, diskGb: 8 },
	M: { key: 'M', label: 'Moyen', cores: 2, memoryMb: 2048, swapMb: 1024, diskGb: 10 },
	L: { key: 'L', label: 'Grand', cores: 4, memoryMb: 4096, swapMb: 2048, diskGb: 20 }
};

export function isSizeKey(v: unknown): v is SizeKey {
	return v === 'S' || v === 'M' || v === 'L';
}

/** Marge de RAM que l'on veut garder libre sur l'hôte après création d'un CT. */
export const HOST_RAM_SAFETY_MARGIN_MB = 1024;

export interface RamAssessment {
	freeMb: number;
	afterMb: number;
	level: 'ok' | 'tight' | 'insufficient';
}

/**
 * Évalue l'impact d'un nouveau CT sur la RAM de l'hôte.
 * - insufficient : la RAM libre ne couvre même pas la RAM du CT
 * - tight : il resterait moins que la marge de sécurité
 */
export function assessHostRam(totalMb: number, usedMb: number, size: ContainerSize): RamAssessment {
	const freeMb = Math.max(0, totalMb - usedMb);
	const afterMb = freeMb - size.memoryMb;
	let level: RamAssessment['level'] = 'ok';
	if (afterMb < 0) level = 'insufficient';
	else if (afterMb < HOST_RAM_SAFETY_MARGIN_MB) level = 'tight';
	return { freeMb, afterMb, level };
}

/** Bornes d'une taille personnalisée (l'hôte a 8 cœurs et ~15 Go). */
export const CUSTOM_LIMITS = { cores: { min: 1, max: 8 }, memoryMb: { min: 512, max: 12288 }, diskGb: { min: 4, max: 200 } } as const;

export interface SizeOverrides {
	cores: number | null;
	memoryMb: number | null;
	diskGb: number | null;
}

/** Taille effective d'un projet : préréglage S/M/L, éventuellement personnalisé. */
export function effectiveSize(key: SizeKey, o: Partial<SizeOverrides> = {}): ContainerSize {
	const base = SIZES[key];
	const memoryMb = o.memoryMb ?? base.memoryMb;
	return {
		...base,
		cores: o.cores ?? base.cores,
		memoryMb,
		// Swap = moitié de la RAM, comme les préréglages.
		swapMb: o.memoryMb ? Math.round(memoryMb / 2) : base.swapMb,
		diskGb: o.diskGb ?? base.diskGb
	};
}

export interface ResizeCheck {
	errors: string[];
	/** Supplément de RAM demandé à l'hôte (négatif si on réduit). */
	extraMemoryMb: number;
}

/**
 * Valide un changement de taille. Le disque ne peut qu'être agrandi (Proxmox ne
 * réduit jamais un disque) ; RAM et cœurs peuvent monter ou descendre.
 */
export function validateResize(current: ContainerSize, target: { cores: number; memoryMb: number; diskGb: number }, currentDiskGb: number): ResizeCheck {
	const errors: string[] = [];
	const L = CUSTOM_LIMITS;
	if (!Number.isInteger(target.cores) || target.cores < L.cores.min || target.cores > L.cores.max) errors.push(`Cœurs : entre ${L.cores.min} et ${L.cores.max}.`);
	if (!Number.isInteger(target.memoryMb) || target.memoryMb < L.memoryMb.min || target.memoryMb > L.memoryMb.max || target.memoryMb % 128 !== 0) {
		errors.push(`RAM : entre ${L.memoryMb.min} et ${L.memoryMb.max} Mo, par pas de 128 Mo.`);
	}
	if (!Number.isInteger(target.diskGb) || target.diskGb > L.diskGb.max) errors.push(`Disque : ${L.diskGb.max} Go maximum.`);
	if (target.diskGb < currentDiskGb) errors.push(`Disque : ${currentDiskGb} Go actuellement, il ne peut qu'être agrandi.`);
	return { errors, extraMemoryMb: target.memoryMb - current.memoryMb };
}

/** Violation d'une règle de sécurité : l'opération est refusée, rien n'est exécuté. */
export class SafetyViolation extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = 'SafetyViolation';
		this.code = code;
	}
}

/** Erreur fonctionnelle à afficher telle quelle à l'utilisateur. */
export class UserFacingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UserFacingError';
	}
}

/** RAM de l'hôte serrée : l'utilisateur peut confirmer et relancer (case dédiée dans le formulaire). */
export class RamTightError extends UserFacingError {
	readonly afterMb: number;
	constructor(message: string, afterMb: number) {
		super(message);
		this.name = 'RamTightError';
		this.afterMb = afterMb;
	}
}

/** Erreur d'appel à une API externe (Proxmox, GitHub, OVH, NPM…). */
export class ExternalApiError extends Error {
	readonly system: string;
	readonly status: number | undefined;
	constructor(system: string, message: string, status?: number) {
		super(`[${system}] ${message}`);
		this.name = 'ExternalApiError';
		this.system = system;
		this.status = status;
	}
}

export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * Garde d'écriture : point de passage UNIQUE de toutes les écritures vers
 * Proxmox, GitHub, OVH, NPM et SSH.
 *   1. applique la règle de sécurité de l'opération (check) — un refus arrête tout ;
 *   2. journalise l'opération (message déjà masqué) ;
 *   3. en DRY_RUN, renvoie une valeur simulée au lieu d'exécuter.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { SafetyViolation } from '$lib/domain/errors';
import type { LogLevel } from '$server/infrastructure/db/schema';

export type WriteSystem = 'proxmox' | 'github' | 'ovh' | 'npm' | 'ssh';

export interface ExecutionScope {
	jobId: number | null;
	stepKey: string | null;
	dryRun: boolean;
	log: (level: LogLevel, message: string) => void;
}

/** Contexte d'exécution courant (job + étape), propagé à travers les appels asynchrones. */
export const executionScope = new AsyncLocalStorage<ExecutionScope>();

export interface WriteOp<T> {
	system: WriteSystem;
	action: string;
	/** Description lisible (sans secret) de ce qui va être fait. */
	summary: string;
	check?: () => void | Promise<void>;
	execute: () => Promise<T>;
	simulate: () => T | Promise<T>;
}

export interface AuditEntry {
	ts: number;
	system: WriteSystem;
	action: string;
	summary: string;
	outcome: 'executed' | 'simulated' | 'refused' | 'failed';
	jobId: number | null;
	error?: string;
}

const SYSTEM_LABEL: Record<WriteSystem, string> = {
	proxmox: 'Proxmox',
	github: 'GitHub',
	ovh: 'OVH',
	npm: 'NPM',
	ssh: 'SSH'
};

export class WriteGuard {
	readonly #audit: AuditEntry[] = [];

	constructor(
		private readonly globalDryRun: () => boolean,
		private readonly redact: (s: string) => string
	) {}

	isDryRun(): boolean {
		return executionScope.getStore()?.dryRun ?? this.globalDryRun();
	}

	recentAudit(limit = 100): AuditEntry[] {
		return this.#audit.slice(-limit).reverse();
	}

	async run<T>(op: WriteOp<T>): Promise<T> {
		const scope = executionScope.getStore();
		const log = scope?.log ?? (() => {});
		const label = `${SYSTEM_LABEL[op.system]} · ${this.redact(op.summary)}`;
		const base = { ts: Date.now(), system: op.system, action: op.action, summary: this.redact(op.summary), jobId: scope?.jobId ?? null };

		try {
			await op.check?.();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.#push({ ...base, outcome: 'refused', error: msg });
			log('error', `⛔ Refusé par le garde de sécurité — ${label} : ${msg}`);
			throw err instanceof SafetyViolation ? err : new SafetyViolation('check.failed', msg);
		}

		if (this.isDryRun()) {
			this.#push({ ...base, outcome: 'simulated' });
			log('dry', `[DRY-RUN] ${label}`);
			return op.simulate();
		}

		log('info', `→ ${label}`);
		try {
			const result = await op.execute();
			this.#push({ ...base, outcome: 'executed' });
			return result;
		} catch (err) {
			this.#push({ ...base, outcome: 'failed', error: err instanceof Error ? err.message : String(err) });
			throw err;
		}
	}

	#push(entry: AuditEntry) {
		this.#audit.push(entry);
		if (this.#audit.length > 500) this.#audit.splice(0, this.#audit.length - 500);
	}
}

/** Valeur simulée reconnaissable (UPID, IDs…) pour le DRY_RUN. */
export const DRY_PREFIX = 'dry-run';
export function isSimulated(value: unknown): boolean {
	return typeof value === 'string' && value.startsWith(DRY_PREFIX);
}

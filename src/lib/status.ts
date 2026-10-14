/** Correspondance statut → libellé français + ton de couleur, partagée par toute l'UI. */

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'ember';

export interface StatusInfo {
	label: string;
	tone: Tone;
	pulse?: boolean;
}

const MAP: Record<string, StatusInfo> = {
	// CT
	running: { label: 'En marche', tone: 'success' },
	stopped: { label: 'Arrêté', tone: 'neutral' },
	paused: { label: 'En pause', tone: 'warning' },
	// Jobs / étapes
	queued: { label: 'En file', tone: 'neutral', pulse: true },
	pending: { label: 'En attente', tone: 'neutral' },
	awaiting_input: { label: 'Confirmation requise', tone: 'warning', pulse: true },
	succeeded: { label: 'Réussi', tone: 'success' },
	failed: { label: 'Échec', tone: 'danger' },
	skipped: { label: 'Ignoré', tone: 'neutral' },
	cancelled: { label: 'Annulé', tone: 'neutral' },
	rolling_back: { label: 'Rollback…', tone: 'warning', pulse: true },
	rolled_back: { label: 'Annulé (rollback)', tone: 'neutral' },
	// Projets
	draft: { label: 'Brouillon', tone: 'neutral' },
	deploying: { label: 'Déploiement…', tone: 'info', pulse: true },
	active: { label: 'Actif', tone: 'success' },
	error: { label: 'Erreur', tone: 'danger' },
	deleting: { label: 'Suppression…', tone: 'warning', pulse: true },
	deleted: { label: 'Supprimé', tone: 'neutral' },
	// Domaines
	dns_ok: { label: 'DNS OK', tone: 'info' },
	removing: { label: 'Retrait…', tone: 'warning', pulse: true },
	// Runs GitHub
	in_progress: { label: 'En cours', tone: 'info', pulse: true },
	completed: { label: 'Terminé', tone: 'neutral' },
	success: { label: 'Réussi', tone: 'success' },
	failure: { label: 'Échec', tone: 'danger' },
	timed_out: { label: 'Délai dépassé', tone: 'danger' },
	// Tests
	ok: { label: 'OK', tone: 'success' },
	warn: { label: 'Attention', tone: 'warning' }
};

export function statusInfo(status: string | null | undefined): StatusInfo {
	if (!status) return { label: '—', tone: 'neutral' };
	return MAP[status] ?? { label: status, tone: 'neutral' };
}

/** Statut d'un run GitHub (status + conclusion). */
export function runStatus(status: string, conclusion: string | null): StatusInfo {
	if (status === 'running') return { label: 'En cours', tone: 'info', pulse: true };
	if (status !== 'completed') return statusInfo(status);
	return statusInfo(conclusion ?? 'completed');
}

export const TONE_TEXT: Record<Tone, string> = {
	success: 'text-success',
	warning: 'text-warning',
	danger: 'text-danger',
	info: 'text-info',
	neutral: 'text-muted-foreground',
	ember: 'text-ember'
};

export const TONE_BG: Record<Tone, string> = {
	success: 'bg-success',
	warning: 'bg-warning',
	danger: 'bg-danger',
	info: 'bg-info',
	neutral: 'bg-muted-foreground/60',
	ember: 'bg-ember'
};

export const TONE_SOFT: Record<Tone, string> = {
	success: 'bg-success/12 text-success ring-success/25',
	warning: 'bg-warning/12 text-warning ring-warning/25',
	danger: 'bg-danger/12 text-danger ring-danger/25',
	info: 'bg-info/12 text-info ring-info/25',
	neutral: 'bg-muted text-muted-foreground ring-border',
	ember: 'bg-ember/12 text-ember ring-ember/25'
};

export function usageTone(ratio: number): Tone {
	if (ratio >= 0.9) return 'danger';
	if (ratio >= 0.75) return 'warning';
	return 'success';
}

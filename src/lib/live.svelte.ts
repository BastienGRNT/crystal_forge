/**
 * Temps réel de l'interface : un seul flux SSE global (/api/events) par onglet,
 * ouvert par le layout. Chaque page s'abonne à ce qui l'intéresse avec `onJobChange`.
 */
import { onDestroy } from 'svelte';

export interface JobChange {
	id: number;
	status: string;
	projectId: number | null;
	slug: string | null;
}

const listeners = new Set<(e: JobChange) => void>();

/** Ouvre le flux (appelé une fois par le layout). Renvoie la fonction de fermeture. */
export function connectLive(): () => void {
	const es = new EventSource('/api/events');
	es.addEventListener('job', (e) => {
		let change: JobChange;
		try {
			change = JSON.parse((e as MessageEvent).data) as JobChange;
		} catch {
			return;
		}
		for (const fn of listeners) fn(change);
	});
	return () => es.close();
}

/** S'abonne aux changements de statut des jobs, le temps de vie du composant. */
export function onJobChange(fn: (e: JobChange) => void): void {
	listeners.add(fn);
	onDestroy(() => listeners.delete(fn));
}

/** Regroupe les rafraîchissements rapprochés (plusieurs événements → un seul appel). */
export function coalesce(fn: () => unknown, ms = 300): () => void {
	let t: ReturnType<typeof setTimeout> | null = null;
	return () => {
		if (t) return;
		t = setTimeout(() => {
			t = null;
			void fn();
		}, ms);
	};
}

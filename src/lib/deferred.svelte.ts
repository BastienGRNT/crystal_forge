/**
 * Donnée transmise en différé par un `load` (promesse en streaming) : la page s'affiche
 * tout de suite, puis la valeur arrive. Pendant un rafraîchissement (invalidate),
 * l'ancienne valeur reste affichée jusqu'à la nouvelle : pas de clignotement.
 * À appeler pendant l'initialisation d'un composant.
 */
export function deferred<T>(source: () => Promise<T>): { readonly value: T | undefined; readonly loading: boolean } {
	let value = $state<T | undefined>(undefined);
	let loading = $state(true);
	$effect(() => {
		const promise = source();
		let current = true;
		loading = true;
		promise.then(
			(v) => {
				if (!current) return;
				value = v;
				loading = false;
			},
			() => {
				if (current) loading = false;
			}
		);
		return () => {
			current = false;
		};
	});
	return {
		get value() {
			return value;
		},
		get loading() {
			return loading;
		}
	};
}

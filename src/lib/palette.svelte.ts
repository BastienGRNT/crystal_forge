/** État partagé de la palette de commandes (Ctrl+K) : ouverte depuis la barre latérale, la barre du haut ou le clavier. */
export const palette = $state({ open: false });

export function openPalette() {
	palette.open = true;
}

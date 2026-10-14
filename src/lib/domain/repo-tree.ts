/** Arborescence d'un dépôt lue en un seul appel (API git/trees récursive). */
export interface TreeEntry {
	path: string;
	type: 'file' | 'dir';
}

/** Contenu direct d'un dossier ('' ou '.' : la racine), comme le renverrait un listing GitHub. */
export function childrenOf(tree: TreeEntry[], dir: string): { name: string; path: string; type: 'file' | 'dir' }[] {
	// « . » et « ./x » désignent la racine ; « .github » est un vrai nom de dossier.
	const clean = (dir === '.' ? '' : dir.replace(/^\.\//, '')).replace(/\/+$/, '');
	const prefix = clean ? `${clean}/` : '';
	return tree
		.filter((e) => e.path.startsWith(prefix) && e.path.length > prefix.length && !e.path.slice(prefix.length).includes('/'))
		.map((e) => ({ name: e.path.slice(prefix.length), path: e.path, type: e.type }));
}

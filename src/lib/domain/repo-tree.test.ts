import { describe, expect, it } from 'vitest';
import { childrenOf, type TreeEntry } from './repo-tree';

const tree: TreeEntry[] = [
	{ path: 'docker-compose.yml', type: 'file' },
	{ path: '.github', type: 'dir' },
	{ path: '.github/workflows', type: 'dir' },
	{ path: '.github/workflows/ci.yml', type: 'file' },
	{ path: 'app', type: 'dir' },
	{ path: 'app/Dockerfile', type: 'file' },
	{ path: 'app/src', type: 'dir' },
	{ path: 'app/src/index.ts', type: 'file' }
];

describe('childrenOf', () => {
	it('liste la racine sans descendre dans les sous-dossiers', () => {
		expect(childrenOf(tree, '').map((e) => e.name)).toEqual(['docker-compose.yml', '.github', 'app']);
		expect(childrenOf(tree, '.')).toEqual(childrenOf(tree, ''));
	});

	it('liste un sous-dossier avec les chemins complets', () => {
		expect(childrenOf(tree, 'app')).toEqual([
			{ name: 'Dockerfile', path: 'app/Dockerfile', type: 'file' },
			{ name: 'src', path: 'app/src', type: 'dir' }
		]);
		expect(childrenOf(tree, '.github/workflows/').map((e) => e.path)).toEqual(['.github/workflows/ci.yml']);
	});

	it('dossier absent : liste vide', () => {
		expect(childrenOf(tree, 'nope')).toEqual([]);
	});
});

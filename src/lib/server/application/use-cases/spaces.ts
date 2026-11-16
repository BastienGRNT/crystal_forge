import { UserFacingError } from '$lib/domain/errors';
import { isSpaceColor, isSpaceIcon, parseTagInput, readTags, validateSpaceName } from '$lib/domain/spaces';
import type { ForgeServices } from '../services';

export interface SpaceView {
	id: number;
	name: string;
	color: string;
	icon: string;
	position: number;
}

/** Espaces (Papa, Perso, Entreprise…) et étiquettes des projets. Rien n'est écrit hors de la base de Forge. */
export class SpaceService {
	constructor(private readonly s: ForgeServices) {}

	list(): SpaceView[] {
		return this.s.repos.spaces.list().map(({ id, name, color, icon, position }) => ({ id, name, color, icon, position }));
	}

	#fields(input: { name: string; color: string; icon: string }) {
		let name: string;
		try {
			name = validateSpaceName(input.name);
		} catch (err) {
			throw new UserFacingError((err as Error).message);
		}
		return { name, color: isSpaceColor(input.color) ? input.color : 'blue', icon: isSpaceIcon(input.icon) ? input.icon : 'folder' };
	}

	create(input: { name: string; color: string; icon: string }): SpaceView {
		const f = this.#fields(input);
		if (this.s.repos.spaces.list().some((x) => x.name.toLowerCase() === f.name.toLowerCase())) throw new UserFacingError(`L'espace « ${f.name} » existe déjà.`);
		return this.s.repos.spaces.create(f);
	}

	update(id: number, input: { name: string; color: string; icon: string }): void {
		if (!this.s.repos.spaces.get(id)) throw new UserFacingError('Espace introuvable.');
		this.s.repos.spaces.update(id, this.#fields(input));
	}

	move(id: number, dir: -1 | 1): void {
		const list = this.s.repos.spaces.list();
		const i = list.findIndex((x) => x.id === id);
		const j = i + dir;
		if (i < 0 || j < 0 || j >= list.length) return;
		[list[i], list[j]] = [list[j]!, list[i]!];
		list.forEach((x, k) => this.s.repos.spaces.update(x.id, { position: k + 1 }));
	}

	delete(id: number): void {
		this.s.repos.spaces.delete(id);
	}

	/** Range un projet dans un espace (null : hors espace) et remplace ses étiquettes. */
	organize(projectId: number, spaceId: number | null, tagInput: string): void {
		if (spaceId !== null && !this.s.repos.spaces.get(spaceId)) throw new UserFacingError('Espace introuvable.');
		let tags: string[];
		try {
			tags = parseTagInput(tagInput);
		} catch (err) {
			throw new UserFacingError((err as Error).message);
		}
		this.s.repos.projects.update(projectId, { spaceId, tags: JSON.stringify(tags) });
	}

	/** Toutes les étiquettes utilisées (pour l'autocomplétion et les filtres). */
	allTags(projects: { tags: string }[]): string[] {
		return [...new Set(projects.flatMap((p) => readTags(p.tags)))].sort();
	}
}

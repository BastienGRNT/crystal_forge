/** Rendu des espaces côté interface : couleurs et icônes. */
import Folder from '@lucide/svelte/icons/folder';
import House from '@lucide/svelte/icons/house';
import User from '@lucide/svelte/icons/user';
import Briefcase from '@lucide/svelte/icons/briefcase';
import Building2 from '@lucide/svelte/icons/building-2';
import Heart from '@lucide/svelte/icons/heart';
import Star from '@lucide/svelte/icons/star';
import Rocket from '@lucide/svelte/icons/rocket';
import FlaskConical from '@lucide/svelte/icons/flask-conical';
import Gamepad2 from '@lucide/svelte/icons/gamepad-2';
import GraduationCap from '@lucide/svelte/icons/graduation-cap';
import Store from '@lucide/svelte/icons/store';
import type { SpaceColor, SpaceIcon } from '$lib/domain/spaces';

export const SPACE_ICON_COMPONENTS: Record<SpaceIcon, typeof Folder> = {
	folder: Folder,
	house: House,
	user: User,
	briefcase: Briefcase,
	building: Building2,
	heart: Heart,
	star: Star,
	rocket: Rocket,
	flask: FlaskConical,
	gamepad: Gamepad2,
	graduation: GraduationCap,
	store: Store
};

/** Teintes lisibles en clair comme en sombre. */
export const SPACE_HEX: Record<SpaceColor, string> = {
	blue: '#3b82f6',
	violet: '#8b5cf6',
	pink: '#ec4899',
	red: '#ef4444',
	orange: '#f97316',
	amber: '#f59e0b',
	green: '#22c55e',
	teal: '#14b8a6',
	cyan: '#06b6d4',
	slate: '#64748b'
};

export const spaceIcon = (icon: string) => SPACE_ICON_COMPONENTS[icon as SpaceIcon] ?? Folder;
export const spaceHex = (color: string) => SPACE_HEX[color as SpaceColor] ?? SPACE_HEX.slate;

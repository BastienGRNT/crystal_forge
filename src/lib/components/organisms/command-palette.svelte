<script lang="ts">
	import { goto } from '$app/navigation';
	import * as Command from '$lib/components/atoms/ui/command';
	import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
	import Boxes from '@lucide/svelte/icons/boxes';
	import Activity from '@lucide/svelte/icons/activity';
	import Server from '@lucide/svelte/icons/server';
	import Settings from '@lucide/svelte/icons/settings';
	import Users from '@lucide/svelte/icons/users';
	import Plus from '@lucide/svelte/icons/plus';
	import SunMoon from '@lucide/svelte/icons/sun-moon';
	import UserRound from '@lucide/svelte/icons/user-round';
	import StatusDot from '$lib/components/atoms/status-dot.svelte';
	import { toggleMode } from 'mode-watcher';
	import { statusInfo } from '$lib/status';
	import { palette } from '$lib/palette.svelte';

	let {
		projects,
		user
	}: {
		projects: { slug: string; name: string; status: string; environment: string }[];
		user: { role: string; canCreate: boolean };
	} = $props();

	const isAdmin = $derived(user.role === 'admin');
	const pages = $derived(
		[
			{ label: "Vue d'ensemble", href: '/', icon: LayoutDashboard, show: isAdmin },
			{ label: 'Projets', href: '/projects', icon: Boxes, show: true },
			{ label: 'Activité (jobs)', href: '/jobs', icon: Activity, show: true },
			{ label: 'Serveur', href: '/server', icon: Server, show: isAdmin },
			{ label: 'Utilisateurs', href: '/users', icon: Users, show: isAdmin },
			{ label: 'Réglages', href: '/settings', icon: Settings, show: isAdmin },
			{ label: 'Mon compte', href: '/account', icon: UserRound, show: true }
		].filter((p) => p.show)
	);

	const TABS = [
		['deployments', 'Déploiements'],
		['logs', 'Logs'],
		['variables', 'Variables'],
		['domains', 'Domaines'],
		['database', 'Base de données'],
		['container', 'Ressources'],
		['settings', 'Paramètres']
	] as const;

	function go(href: string) {
		palette.open = false;
		void goto(href);
	}

	function onkeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			palette.open = !palette.open;
		}
	}
</script>

<svelte:window {onkeydown} />

<Command.Dialog bind:open={palette.open} title="Aller à…" description="Cherchez un projet, une page ou une action">
	<Command.Input placeholder="Projet, page, action… (ex. « notes logs »)" />
	<Command.List class="max-h-[60vh]">
		<Command.Empty>Rien trouvé.</Command.Empty>
		{#if projects.length}
			<Command.Group heading="Projets">
				{#each projects as p (p.slug)}
					{@const s = statusInfo(p.status)}
					<Command.Item value="{p.name} {p.slug}" onSelect={() => go(`/projects/${p.slug}`)}>
						<StatusDot tone={s.tone} class="mx-1" />
						<span>{p.name}</span>
						<span class="ml-auto text-xs text-muted-foreground">{p.environment === 'development' ? 'dev' : 'prod'} · {s.label}</span>
					</Command.Item>
				{/each}
			</Command.Group>
			<Command.Group heading="Sections des projets">
				{#each projects as p (p.slug)}
					{#each TABS as [tab, label] (tab)}
						<Command.Item value="{p.name} {p.slug} {label}" onSelect={() => go(`/projects/${p.slug}/${tab}`)}>
							<span class="text-muted-foreground">{p.name} ›</span> <span>{label}</span>
						</Command.Item>
					{/each}
				{/each}
			</Command.Group>
		{/if}
		<Command.Group heading="Pages">
			{#each pages as p (p.href)}
				{@const Icon = p.icon}
				<Command.Item value={p.label} onSelect={() => go(p.href)}><Icon /> {p.label}</Command.Item>
			{/each}
		</Command.Group>
		<Command.Group heading="Actions">
			{#if user.canCreate}<Command.Item value="Nouveau projet créer" onSelect={() => go('/projects/new')}><Plus /> Créer un projet</Command.Item>{/if}
			<Command.Item value="Thème clair sombre" onSelect={() => { toggleMode(); palette.open = false; }}><SunMoon /> Changer de thème</Command.Item>
		</Command.Group>
	</Command.List>
</Command.Dialog>

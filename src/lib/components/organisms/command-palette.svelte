<script lang="ts">
	import { goto } from '$app/navigation';
	import * as Command from '$lib/components/atoms/ui/command';
	import Boxes from '@lucide/svelte/icons/boxes';
	import Box from '@lucide/svelte/icons/box';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import Server from '@lucide/svelte/icons/server';
	import Settings from '@lucide/svelte/icons/settings';
	import Users from '@lucide/svelte/icons/users';
	import Plus from '@lucide/svelte/icons/plus';

	let {
		projects,
		user
	}: {
		projects: { slug: string; name: string; status: string }[];
		user: { role: string; canCreate: boolean };
	} = $props();

	let open = $state(false);

	const pages = $derived(
		[
			{ label: 'Projets', href: '/projects', icon: Boxes, show: true },
			{ label: 'Nouveau projet', href: '/projects/new', icon: Plus, show: user.canCreate },
			{ label: 'Jobs', href: '/jobs', icon: ListChecks, show: true },
			{ label: 'Serveur', href: '/server', icon: Server, show: user.role === 'admin' },
			{ label: 'Utilisateurs', href: '/users', icon: Users, show: user.role === 'admin' },
			{ label: 'Réglages', href: '/settings', icon: Settings, show: user.role === 'admin' }
		].filter((p) => p.show)
	);

	const TABS = [
		['', 'Aperçu'],
		['deployments', 'Déploiements'],
		['container', 'Conteneur'],
		['domains', 'Domaines']
	] as const;

	function go(href: string) {
		open = false;
		void goto(href);
	}

	function onkeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			open = !open;
		}
	}
</script>

<svelte:window {onkeydown} />

<Command.Dialog bind:open title="Aller à…" description="Cherchez un projet ou une page">
	<Command.Input placeholder="Projet, page… (Ctrl+K)" />
	<Command.List>
		<Command.Empty>Rien trouvé.</Command.Empty>
		{#if projects.length}
			<Command.Group heading="Projets">
				{#each projects as p (p.slug)}
					{#each TABS as [tab, label] (tab)}
						<Command.Item value="{p.name} {p.slug} {tab ? label : ''}" onSelect={() => go(`/projects/${p.slug}${tab ? `/${tab}` : ''}`)}>
							<Box /> <span>{p.name}</span>{#if tab}<span class="text-muted-foreground">· {label}</span>{/if}
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
	</Command.List>
</Command.Dialog>

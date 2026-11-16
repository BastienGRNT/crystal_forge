<script lang="ts">
	import { page } from '$app/state';
	import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
	import Boxes from '@lucide/svelte/icons/boxes';
	import Plus from '@lucide/svelte/icons/plus';
	import Activity from '@lucide/svelte/icons/activity';
	import Settings from '@lucide/svelte/icons/settings';
	import Server from '@lucide/svelte/icons/server';
	import Users from '@lucide/svelte/icons/users';
	import Search from '@lucide/svelte/icons/search';
	import Moon from '@lucide/svelte/icons/moon';
	import Logo from '$lib/components/atoms/logo.svelte';
	import Meter from '$lib/components/atoms/meter.svelte';
	import StatusDot from '$lib/components/atoms/status-dot.svelte';
	import Spinner from '$lib/components/atoms/spinner.svelte';
	import UserMenu from '$lib/components/molecules/user-menu.svelte';
	import { bytes } from '$lib/format';
	import { statusInfo } from '$lib/status';
	import { openPalette } from '$lib/palette.svelte';
	import { cn } from '$lib/utils';

	let {
		projects,
		activeJobs,
		host,
		user,
		onNavigate
	}: {
		user: { username: string; role: 'admin' | 'collaborator'; canCreate?: boolean };
		projects: { slug: string; name: string; status: string; environment: string; sleeping: boolean }[];
		activeJobs: number;
		host: { memUsed: number; memTotal: number; cpu: number } | null;
		onNavigate?: () => void;
	} = $props();

	const isAdmin = $derived(user.role === 'admin');
	// Masquer un lien n'est qu'un confort : les droits sont vérifiés côté serveur (hooks.server.ts).
	const main = $derived(
		[
			{ href: '/', label: "Vue d'ensemble", icon: LayoutDashboard, exact: true, show: isAdmin },
			{ href: '/projects', label: 'Projets', icon: Boxes, exact: true, show: true },
			{ href: '/jobs', label: 'Activité', icon: Activity, exact: false, show: true }
		].filter((i) => i.show)
	);
	const admin = [
		{ href: '/server', label: 'Serveur', icon: Server, exact: false },
		{ href: '/users', label: 'Utilisateurs', icon: Users, exact: false },
		{ href: '/settings', label: 'Réglages', icon: Settings, exact: false }
	];
	const isActive = (href: string, exact: boolean) => (exact ? page.url.pathname === href : page.url.pathname.startsWith(href));
	const canCreate = $derived(isAdmin || !!user.canCreate);
	const memRatio = $derived(host ? host.memUsed / host.memTotal : 0);
</script>

{#snippet navLink(item: { href: string; label: string; icon: typeof Boxes; exact: boolean })}
	{@const active = isActive(item.href, item.exact)}
	<a
		href={item.href}
		onclick={onNavigate}
		class={cn(
			'group relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors',
			active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground'
		)}
		aria-current={active ? 'page' : undefined}
	>
		{#if active}<span class="absolute top-1.5 bottom-1.5 -left-3 w-0.5 rounded-r bg-ember"></span>{/if}
		<item.icon class={cn('size-4 shrink-0', active ? 'text-foreground' : 'text-muted-foreground/80 group-hover:text-foreground')} />
		<span class="flex-1 truncate">{item.label}</span>
		{#if item.href === '/jobs' && activeJobs > 0}
			<span class="inline-flex items-center gap-1 rounded-full bg-info/12 px-1.5 py-0.5 text-[11px] font-semibold text-info tabular-nums"><Spinner class="size-3" />{activeJobs}</span>
		{:else if item.href === '/projects'}
			<span class="text-[11px] text-muted-foreground/70 tabular-nums">{projects.length}</span>
		{/if}
	</a>
{/snippet}

<div class="flex h-full flex-col">
	<div class="flex h-14 shrink-0 items-center justify-between px-4">
		<a href={isAdmin ? '/' : '/projects'} onclick={onNavigate} aria-label="Accueil"><Logo /></a>
	</div>

	<div class="px-3 pb-2">
		<button
			type="button"
			onclick={() => {
				onNavigate?.();
				openPalette();
			}}
			class="flex h-8 w-full items-center gap-2 rounded-md border bg-background/60 px-2.5 text-[13px] text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
		>
			<Search class="size-3.5" />
			<span class="flex-1 text-left">Rechercher…</span>
			<kbd class="rounded border bg-muted/60 px-1.5 font-mono text-[10px]">Ctrl K</kbd>
		</button>
	</div>

	<div class="scrollbar-thin flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 py-2">
		<nav class="flex flex-col gap-0.5" aria-label="Navigation principale">
			{#each main as item (item.href)}{@render navLink(item)}{/each}
		</nav>

		{#if isAdmin}
			<nav class="flex flex-col gap-0.5" aria-label="Administration">
				<p class="mb-1 px-2.5 text-[11px] font-medium text-muted-foreground/60">Administration</p>
				{#each admin as item (item.href)}{@render navLink(item)}{/each}
			</nav>
		{/if}

		<div class="flex flex-col gap-0.5">
			<div class="mb-1 flex items-center justify-between px-2.5">
				<p class="text-[11px] font-medium text-muted-foreground/60">Mes projets</p>
				{#if canCreate}
					<a href="/projects/new" onclick={onNavigate} class="grid size-5 place-items-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-foreground" title="Nouveau projet" aria-label="Nouveau projet"><Plus class="size-3.5" /></a>
				{/if}
			</div>
			{#each projects as p (p.slug)}
				{@const s = statusInfo(p.status)}
				{@const active = page.url.pathname === `/projects/${p.slug}` || page.url.pathname.startsWith(`/projects/${p.slug}/`)}
				<a
					href="/projects/{p.slug}"
					onclick={onNavigate}
					class={cn(
						'group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors',
						active ? 'bg-sidebar-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground'
					)}
				>
					{#if p.sleeping}
						<Moon class="size-3 shrink-0 text-muted-foreground" />
					{:else}
						<StatusDot tone={s.tone} pulse={s.pulse} class="ml-0.5" />
					{/if}
					<span class="flex-1 truncate">{p.name}</span>
					{#if p.environment === 'development'}<span class="rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground">dev</span>{/if}
				</a>
			{:else}
				{#if canCreate}
					<a href="/projects/new" onclick={onNavigate} class="mx-0.5 flex items-center gap-2 rounded-md border border-dashed px-2.5 py-2 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground"><Plus class="size-3.5" /> Créer un premier projet</a>
				{:else}
					<p class="px-2.5 text-xs text-muted-foreground">Aucun projet partagé avec vous.</p>
				{/if}
			{/each}
		</div>
	</div>

	<div class="shrink-0 space-y-2 border-t border-sidebar-border p-3">
		{#if host}
			<a href="/server" onclick={onNavigate} class="block rounded-md px-2.5 py-2 transition-colors hover:bg-sidebar-accent/60" title="RAM utilisée sur le serveur">
				<div class="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
					<span>RAM du serveur</span>
					<span class="tabular-nums">{Math.round(memRatio * 100)} % · {bytes(host.memTotal - host.memUsed)} libres</span>
				</div>
				<Meter value={memRatio} size="sm" />
			</a>
		{/if}
		<UserMenu {user} {onNavigate} />
	</div>
</div>

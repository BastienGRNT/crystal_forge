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
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Folder from '@lucide/svelte/icons/folder';
	import FolderCog from '@lucide/svelte/icons/folder-cog';
	import Layers from '@lucide/svelte/icons/layers';
	import Logo from '$lib/components/atoms/logo.svelte';
	import Meter from '$lib/components/atoms/meter.svelte';
	import StatusDot from '$lib/components/atoms/status-dot.svelte';
	import Spinner from '$lib/components/atoms/spinner.svelte';
	import UserMenu from '$lib/components/molecules/user-menu.svelte';
	import { bytes } from '$lib/format';
	import { statusInfo } from '$lib/status';
	import { openPalette } from '$lib/palette.svelte';
	import { cn } from '$lib/utils';
	import { spaceHex, spaceIcon } from '$lib/spaces';

	type SidebarProject = { slug: string; name: string; status: string; environment: string; sleeping: boolean; spaceId?: number | null };
	type SidebarSpace = { id: number; name: string; color: string; icon: string };
	let {
		projects,
		spaces = [],
		activeJobs,
		host,
		user,
		collapsed = false,
		onNavigate
	}: {
		user: { username: string; role: 'admin' | 'collaborator'; canCreate?: boolean };
		projects: SidebarProject[];
		spaces?: SidebarSpace[];
		activeJobs: number;
		host: { memUsed: number; memTotal: number; cpu: number } | null;
		/** Barre réduite aux icônes (bureau uniquement). */
		collapsed?: boolean;
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
		{ href: '/spaces', label: 'Espaces', icon: Layers, exact: false },
		{ href: '/users', label: 'Utilisateurs', icon: Users, exact: false },
		{ href: '/settings', label: 'Réglages', icon: Settings, exact: false }
	];
	// Projets rangés par espace (ordre des espaces), puis ceux hors espace.
	const groups = $derived.by(() => {
		const out: { key: string; space: SidebarSpace | null; items: SidebarProject[] }[] = spaces
			.map((sp) => ({ key: `s${sp.id}`, space: sp as SidebarSpace | null, items: projects.filter((p) => p.spaceId === sp.id) }))
			.filter((g) => g.items.length);
		const loose = projects.filter((p) => !p.spaceId || !spaces.some((sp) => sp.id === p.spaceId));
		if (loose.length) out.push({ key: 'loose', space: null, items: loose });
		return out;
	});
	// Groupes repliés : mémorisés dans ce navigateur.
	const FOLD_KEY = 'forge.sidebar.folded';
	let folded = $state(new Set<string>());
	$effect(() => {
		try {
			folded = new Set(JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]') as string[]);
		} catch {
			/* stockage indisponible */
		}
	});
	function toggleGroup(key: string) {
		const next = new Set(folded);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		folded = next;
		try {
			localStorage.setItem(FOLD_KEY, JSON.stringify([...next]));
		} catch {
			/* stockage indisponible */
		}
	}
	// Le projet ouvert reste visible même si son groupe est replié.
	$effect(() => {
		const slug = page.url.pathname.split('/')[2];
		const g = groups.find((x) => x.items.some((p) => p.slug === slug));
		if (g && folded.has(g.key)) {
			const next = new Set(folded);
			next.delete(g.key);
			folded = next;
		}
	});
	const isActive = (href: string, exact: boolean) => (exact ? page.url.pathname === href : page.url.pathname.startsWith(href));
	const isProjectActive = (slug: string) => page.url.pathname === `/projects/${slug}` || page.url.pathname.startsWith(`/projects/${slug}/`);
	const canCreate = $derived(isAdmin || !!user.canCreate);
	const memRatio = $derived(host ? host.memUsed / host.memTotal : 0);
	const initials = (name: string) =>
		name
			.split(/[\s\-_.]+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((w) => w[0]!.toUpperCase())
			.join('') || '?';
</script>

{#snippet navLink(item: { href: string; label: string; icon: typeof Boxes; exact: boolean })}
	{@const active = isActive(item.href, item.exact)}
	<a
		href={item.href}
		onclick={onNavigate}
		title={collapsed ? item.label : undefined}
		class={cn(
			'group relative flex h-8 items-center gap-2.5 rounded-md text-[13px] font-medium transition-colors',
			collapsed ? 'justify-center px-0' : 'px-2',
			active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground'
		)}
		aria-current={active ? 'page' : undefined}
	>
		{#if active}<span class="absolute top-2 bottom-2 -left-2 w-[3px] rounded-r-sm bg-ember shadow-[0_0_10px_var(--ember)]"></span>{/if}
		<item.icon class={cn('size-4 shrink-0', active ? 'text-foreground' : 'text-muted-foreground/80 group-hover:text-foreground')} />
		{#if !collapsed}
			<span class="flex-1 truncate">{item.label}</span>
			{#if item.href === '/jobs' && activeJobs > 0}
				<span class="inline-flex items-center gap-1 rounded-sm bg-info/12 px-1.5 py-px font-mono text-[10.5px] font-semibold text-info tabular-nums"><Spinner class="size-2.5" />{activeJobs}</span>
			{:else if item.href === '/projects'}
				<span class="font-mono text-[10.5px] text-muted-foreground/60 tabular-nums">{projects.length}</span>
			{/if}
		{:else if item.href === '/jobs' && activeJobs > 0}
			<span class="absolute top-1 right-1 size-1.5 rounded-full bg-info glow text-info"></span>
		{/if}
	</a>
{/snippet}

{#snippet projectLink(p: SidebarProject)}
	{@const st = statusInfo(p.status)}
	{@const active = isProjectActive(p.slug)}
	{#if collapsed}
		<a
			href="/projects/{p.slug}"
			onclick={onNavigate}
			title={p.name}
			class={cn(
				'relative mx-auto grid size-8 place-items-center rounded-md border font-mono text-[10.5px] font-semibold transition-colors',
				active ? 'border-ember/50 bg-ember/10 text-foreground' : 'border-transparent bg-foreground/[0.04] text-muted-foreground hover:text-foreground'
			)}
		>
			{initials(p.name)}
			<span class="absolute -right-0.5 -bottom-0.5 rounded-full bg-sidebar p-[2px]">
				{#if p.sleeping}<Moon class="size-2 text-info" />{:else}<StatusDot tone={st.tone} class="size-1.5" />{/if}
			</span>
		</a>
	{:else}
		<a
			href="/projects/{p.slug}"
			onclick={onNavigate}
			class={cn(
				'group flex h-7.5 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors',
				active ? 'bg-sidebar-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground'
			)}
		>
			{#if p.sleeping}
				<Moon class="size-3 shrink-0 text-info/80" />
			{:else}
				<StatusDot tone={st.tone} pulse={st.pulse} class="mx-0.5 size-1.5" />
			{/if}
			<span class="flex-1 truncate">{p.name}</span>
			{#if p.environment === 'development'}<span class="font-mono text-[9.5px] font-medium tracking-wider text-info/80 uppercase">dev</span>{/if}
		</a>
	{/if}
{/snippet}

{#snippet sectionLabel(text: string)}
	{#if collapsed}
		<div class="mx-auto my-1.5 h-px w-5 bg-sidebar-border"></div>
	{:else}
		<p class="label-caps mb-1 px-2 text-muted-foreground/55">{text}</p>
	{/if}
{/snippet}

<div class="flex h-full flex-col">
	<div class={cn('flex h-12 shrink-0 items-center', collapsed ? 'justify-center' : 'px-4')}>
		<a href={isAdmin ? '/' : '/projects'} onclick={onNavigate} aria-label="Accueil"><Logo withText={!collapsed} /></a>
	</div>

	<div class={cn('pb-2', collapsed ? 'px-2' : 'px-3')}>
		<button
			type="button"
			onclick={() => {
				onNavigate?.();
				openPalette();
			}}
			title={collapsed ? 'Rechercher (Ctrl K)' : undefined}
			class={cn(
				'flex h-8 w-full items-center gap-2 rounded-md border bg-foreground/[0.03] text-[13px] text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground',
				collapsed ? 'justify-center' : 'px-2.5'
			)}
		>
			<Search class="size-3.5" />
			{#if !collapsed}
				<span class="flex-1 text-left">Rechercher…</span>
				<kbd class="rounded-sm border bg-background px-1 font-mono text-[10px] leading-4">Ctrl K</kbd>
			{/if}
		</button>
	</div>

	<div class={cn('scrollbar-thin flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto py-2', collapsed ? 'px-2' : 'px-3')}>
		<nav class="flex flex-col gap-px" aria-label="Navigation principale">
			{#each main as item (item.href)}{@render navLink(item)}{/each}
		</nav>

		{#if isAdmin}
			<nav class="flex flex-col gap-px" aria-label="Administration">
				{@render sectionLabel('Administration')}
				{#each admin as item (item.href)}{@render navLink(item)}{/each}
			</nav>
		{/if}

		<div class="flex flex-col gap-px">
			{#if collapsed}
				{@render sectionLabel('Mes projets')}
			{:else}
				<div class="mb-1 flex items-center justify-between px-2">
					<p class="label-caps text-muted-foreground/55">Mes projets</p>
					<div class="flex items-center gap-0.5">
						{#if isAdmin}
							<a href="/spaces" onclick={onNavigate} class="grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground" title="Gérer les espaces" aria-label="Gérer les espaces"><FolderCog class="size-3.5" /></a>
						{/if}
						{#if canCreate}
							<a href="/projects/new" onclick={onNavigate} class="grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground" title="Nouveau projet" aria-label="Nouveau projet"><Plus class="size-3.5" /></a>
						{/if}
					</div>
				</div>
			{/if}
			{#each groups as grp (grp.key)}
				{#if grp.space}
					{@const hex = spaceHex(grp.space.color)}
					{@const Icon = spaceIcon(grp.space.icon)}
					{@const open = !folded.has(grp.key)}
					{#if collapsed}
						<div class="mx-auto mt-1.5 mb-0.5 h-0.5 w-5 rounded-full" style="background: {hex}" title={grp.space.name}></div>
					{:else}
						<button
							type="button"
							class="group/sp mt-1.5 flex h-7 items-center gap-2 rounded-md px-2 text-left text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
							onclick={() => toggleGroup(grp.key)}
							aria-expanded={open}
						>
							<Icon class="size-3.5 shrink-0" style="color: {hex}" />
							<span class="flex-1 truncate">{grp.space.name}</span>
							<span class="font-mono text-[10px] text-muted-foreground/50 tabular-nums">{grp.items.length}</span>
							<ChevronRight class={cn('size-3 shrink-0 text-muted-foreground/50 transition-transform', open && 'rotate-90')} />
						</button>
					{/if}
				{:else if groups.length > 1}
					{#if collapsed}
						<div class="mx-auto mt-1.5 mb-0.5 h-0.5 w-5 rounded-full bg-sidebar-border"></div>
					{:else}
						<button type="button" class="mt-1.5 flex h-7 items-center gap-2 rounded-md px-2 text-left text-[12px] font-medium text-muted-foreground/70 hover:text-foreground" onclick={() => toggleGroup(grp.key)} aria-expanded={!folded.has(grp.key)}>
							<Folder class="size-3.5 shrink-0" />
							<span class="flex-1 truncate">Hors espace</span>
							<span class="font-mono text-[10px] text-muted-foreground/50 tabular-nums">{grp.items.length}</span>
							<ChevronRight class={cn('size-3 shrink-0 text-muted-foreground/50 transition-transform', !folded.has(grp.key) && 'rotate-90')} />
						</button>
					{/if}
				{/if}
				{#if collapsed || !folded.has(grp.key)}
					<div class={cn('flex flex-col gap-px', grp.space && !collapsed && 'relative ml-[15px] border-l border-sidebar-border pl-1.5')}>
						{#each grp.items as p (p.slug)}{@render projectLink(p)}{/each}
					</div>
				{/if}
			{:else}
				{#if !collapsed}
					{#if canCreate}
						<a href="/projects/new" onclick={onNavigate} class="mx-0.5 flex items-center gap-2 rounded-md border border-dashed px-2.5 py-2 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground"><Plus class="size-3.5" /> Créer un premier projet</a>
					{:else}
						<p class="px-2 text-xs text-muted-foreground">Aucun projet partagé avec vous.</p>
					{/if}
				{/if}
			{/each}
		</div>
	</div>

	<div class={cn('shrink-0 space-y-1.5 border-t border-sidebar-border', collapsed ? 'p-2' : 'p-2.5')}>
		{#if host && !collapsed}
			<a href="/server" onclick={onNavigate} class="block rounded-md px-2 py-2 transition-colors hover:bg-sidebar-accent/60" title="RAM utilisée sur le serveur">
				<div class="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
					<span class="label-caps">RAM hôte</span>
					<span class="font-mono text-[10.5px] tabular-nums">{Math.round(memRatio * 100)}% · {bytes(host.memTotal - host.memUsed)} libres</span>
				</div>
				<Meter value={memRatio} size="sm" />
			</a>
		{/if}
		<UserMenu {user} {onNavigate} compact={collapsed} />
	</div>
</div>

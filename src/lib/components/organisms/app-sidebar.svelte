<script lang="ts">
	import { page } from '$app/state';
	import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
	import Boxes from '@lucide/svelte/icons/boxes';
	import Plus from '@lucide/svelte/icons/plus';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import Settings from '@lucide/svelte/icons/settings';
	import HeartPulse from '@lucide/svelte/icons/heart-pulse';
	import LogOut from '@lucide/svelte/icons/log-out';
	import Sun from '@lucide/svelte/icons/sun';
	import Moon from '@lucide/svelte/icons/moon';
	import MemoryStick from '@lucide/svelte/icons/memory-stick';
	import { toggleMode } from 'mode-watcher';
	import Logo from '$lib/components/atoms/logo.svelte';
	import Meter from '$lib/components/atoms/meter.svelte';
	import StatusDot from '$lib/components/atoms/status-dot.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import { bytes } from '$lib/format';
	import { statusInfo } from '$lib/status';
	import { cn } from '$lib/utils';

	let {
		projects,
		activeJobs,
		host,
		onNavigate
	}: {
		projects: { slug: string; name: string; status: string }[];
		activeJobs: number;
		host: { memUsed: number; memTotal: number; cpu: number } | null;
		onNavigate?: () => void;
	} = $props();

	const nav = [
		{ href: '/', label: 'Tableau de bord', icon: LayoutDashboard, exact: true },
		{ href: '/projects', label: 'Projets', icon: Boxes, exact: true },
		{ href: '/jobs', label: 'Jobs', icon: ListChecks, exact: false },
		{ href: '/server', label: 'Santé du serveur', icon: HeartPulse, exact: false },
		{ href: '/settings', label: 'Réglages', icon: Settings, exact: false }
	];
	const isActive = (href: string, exact: boolean) => (exact ? page.url.pathname === href : page.url.pathname.startsWith(href));
</script>

<div class="flex h-full flex-col gap-4 p-3">
	<a href="/" class="flex h-10 items-center px-2" onclick={onNavigate}><Logo /></a>

	<Button href="/projects/new" class="mx-1 justify-start gap-2 bg-ember text-ember-foreground hover:bg-ember/90" onclick={onNavigate}>
		<Plus />
		Nouveau projet
	</Button>

	<nav class="flex flex-col gap-0.5" aria-label="Navigation principale">
		{#each nav as item (item.href)}
			{@const active = isActive(item.href, item.exact)}
			<a
				href={item.href}
				onclick={onNavigate}
				class={cn(
					'group flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium transition-colors',
					active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground'
				)}
				aria-current={active ? 'page' : undefined}
			>
				<item.icon class={cn('size-4', active && 'text-ember')} />
				<span class="flex-1">{item.label}</span>
				{#if item.href === '/jobs' && activeJobs > 0}
					<span class="grid h-5 min-w-5 place-items-center rounded-full bg-info/15 px-1.5 text-[11px] font-semibold text-info tabular-nums">{activeJobs}</span>
				{/if}
			</a>
		{/each}
	</nav>

	{#if projects.length}
		<div class="flex min-h-0 flex-col gap-1">
			<p class="px-2.5 text-[11px] font-medium tracking-wider text-muted-foreground/70 uppercase">Projets</p>
			<div class="scrollbar-thin flex min-h-0 flex-col gap-0.5 overflow-y-auto">
				{#each projects as p (p.slug)}
					{@const s = statusInfo(p.status)}
					{@const active = page.url.pathname.startsWith(`/projects/${p.slug}`)}
					<a
						href="/projects/{p.slug}"
						onclick={onNavigate}
						class={cn(
							'flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors',
							active ? 'bg-sidebar-accent text-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground'
						)}
					>
						<StatusDot tone={s.tone} pulse={s.pulse} />
						<span class="truncate">{p.name}</span>
					</a>
				{/each}
			</div>
		</div>
	{/if}

	<div class="mt-auto space-y-3">
		{#if host}
			<a href="/" class="block rounded-lg border bg-background/40 p-3 transition-colors hover:bg-background/70" onclick={onNavigate}>
				<div class="mb-2 flex items-center justify-between text-xs">
					<span class="inline-flex items-center gap-1.5 font-medium text-muted-foreground"><MemoryStick class="size-3.5" /> RAM hôte</span>
					<span class="text-muted-foreground tabular-nums">{bytes(host.memTotal - host.memUsed)} libres</span>
				</div>
				<Meter value={host.memUsed / host.memTotal} size="sm" />
			</a>
		{/if}
		<div class="flex items-center gap-1">
			<Button variant="ghost" size="icon-sm" onclick={toggleMode} aria-label="Changer de thème" title="Thème clair / sombre">
				<Sun class="hidden dark:block" />
				<Moon class="dark:hidden" />
			</Button>
			<form method="POST" action="/logout" class="ml-auto">
				<Button type="submit" variant="ghost" size="sm" class="text-muted-foreground"><LogOut /> Déconnexion</Button>
			</form>
		</div>
	</div>
</div>

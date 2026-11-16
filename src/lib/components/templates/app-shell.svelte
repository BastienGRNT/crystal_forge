<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Sheet from '$lib/components/atoms/ui/sheet';
	import AppSidebar from '$lib/components/organisms/app-sidebar.svelte';
	import TopBar from '$lib/components/organisms/top-bar.svelte';
	import { cn } from '$lib/utils';
	import type { JobSummary } from '$server/application/use-cases/jobs';
	import type { NotificationItem } from '$lib/components/organisms/notification-bell.svelte';

	type ShellProject = { slug: string; name: string; status: string; environment: string; sleeping: boolean; spaceId?: number | null };
	type ShellSpace = { id: number; name: string; color: string; icon: string };
	type ShellNotes = { items: NotificationItem[]; unread: number; seenAt: number };
	let {
		mode,
		dryRun,
		projects,
		spaces = [],
		notifications,
		activeJobs,
		activeJobList,
		host,
		user,
		children
	}: {
		mode: 'live' | 'mock';
		dryRun: boolean;
		projects: ShellProject[];
		spaces?: ShellSpace[];
		notifications?: ShellNotes;
		activeJobs: number;
		activeJobList: JobSummary[];
		host: { memUsed: number; memTotal: number; cpu: number } | null;
		user: { username: string; role: 'admin' | 'collaborator'; canCreate?: boolean };
		children: Snippet;
	} = $props();

	let mobileOpen = $state(false);

	// Barre latérale réduite aux icônes : préférence mémorisée dans ce navigateur.
	const KEY = 'forge.sidebar.collapsed';
	let collapsed = $state(false);
	$effect(() => {
		try {
			collapsed = localStorage.getItem(KEY) === '1';
		} catch {
			/* stockage indisponible */
		}
	});
	function toggleSidebar() {
		collapsed = !collapsed;
		try {
			localStorage.setItem(KEY, collapsed ? '1' : '0');
		} catch {
			/* stockage indisponible */
		}
	}
</script>

<div class="flex min-h-dvh">
	<aside
		class={cn(
			'sticky top-0 hidden h-dvh shrink-0 border-r border-sidebar-border bg-sidebar transition-[width] duration-200 ease-out lg:block',
			collapsed ? 'w-14' : 'w-56'
		)}
	>
		<AppSidebar {projects} {spaces} {activeJobs} {host} {user} {collapsed} />
	</aside>

	<Sheet.Root bind:open={mobileOpen}>
		<Sheet.Content side="left" class="w-72 bg-sidebar p-0">
			<AppSidebar {projects} {spaces} {activeJobs} {host} {user} onNavigate={() => (mobileOpen = false)} />
		</Sheet.Content>
	</Sheet.Root>

	<div class="relative flex min-w-0 flex-1 flex-col">
		<!-- Quadrillage + halo d'accent derrière le haut de chaque page. -->
		<div class="pointer-events-none absolute inset-x-0 top-0 h-72 overflow-hidden" aria-hidden="true">
			<div class="bg-grid-fade absolute inset-0"></div>
			<div class="bg-ember-halo absolute inset-0 opacity-70"></div>
		</div>
		<TopBar {mode} {dryRun} {activeJobList} {projects} {collapsed} {notifications} onMenu={() => (mobileOpen = true)} onToggleSidebar={toggleSidebar} />
		<main class="relative mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-7">
			{@render children()}
		</main>
	</div>
</div>

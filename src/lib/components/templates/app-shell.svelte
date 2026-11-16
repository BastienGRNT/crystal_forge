<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Sheet from '$lib/components/atoms/ui/sheet';
	import AppSidebar from '$lib/components/organisms/app-sidebar.svelte';
	import TopBar from '$lib/components/organisms/top-bar.svelte';
	import type { JobSummary } from '$server/application/use-cases/jobs';

	let {
		mode,
		dryRun,
		projects,
		activeJobs,
		activeJobList,
		host,
		user,
		children
	}: {
		mode: 'live' | 'mock';
		dryRun: boolean;
		projects: { slug: string; name: string; status: string; environment: string; sleeping: boolean }[];
		activeJobs: number;
		activeJobList: JobSummary[];
		host: { memUsed: number; memTotal: number; cpu: number } | null;
		user: { username: string; role: 'admin' | 'collaborator'; canCreate?: boolean };
		children: Snippet;
	} = $props();
	let mobileOpen = $state(false);
</script>

<div class="flex min-h-dvh">
	<aside class="sticky top-0 hidden h-dvh w-60 shrink-0 border-r border-sidebar-border bg-sidebar lg:block">
		<AppSidebar {projects} {activeJobs} {host} {user} />
	</aside>

	<Sheet.Root bind:open={mobileOpen}>
		<Sheet.Content side="left" class="w-72 bg-sidebar p-0">
			<AppSidebar {projects} {activeJobs} {host} {user} onNavigate={() => (mobileOpen = false)} />
		</Sheet.Content>
	</Sheet.Root>

	<div class="flex min-w-0 flex-1 flex-col">
		<TopBar {mode} {dryRun} {activeJobList} onMenu={() => (mobileOpen = true)} />
		<main class="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
			{@render children()}
		</main>
	</div>
</div>

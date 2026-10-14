<script lang="ts">
	import type { Snippet } from 'svelte';
	import Menu from '@lucide/svelte/icons/menu';
	import * as Sheet from '$lib/components/atoms/ui/sheet';
	import { Button } from '$lib/components/atoms/ui/button';
	import Logo from '$lib/components/atoms/logo.svelte';
	import AppSidebar from '$lib/components/organisms/app-sidebar.svelte';
	import ModeBanner from '$lib/components/organisms/mode-banner.svelte';

	let {
		mode,
		dryRun,
		projects,
		activeJobs,
		host,
		children
	}: {
		mode: 'live' | 'mock';
		dryRun: boolean;
		projects: { slug: string; name: string; status: string }[];
		activeJobs: number;
		host: { memUsed: number; memTotal: number; cpu: number } | null;
		children: Snippet;
	} = $props();
	let mobileOpen = $state(false);
</script>

<div class="flex min-h-dvh">
	<aside class="sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-sidebar-border bg-sidebar lg:block">
		<AppSidebar {projects} {activeJobs} {host} />
	</aside>

	<div class="flex min-w-0 flex-1 flex-col">
		<ModeBanner {mode} {dryRun} />
		<div class="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur lg:hidden">
			<Sheet.Root bind:open={mobileOpen}>
				<Sheet.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="ghost" size="icon" aria-label="Menu"><Menu /></Button>
					{/snippet}
				</Sheet.Trigger>
				<Sheet.Content side="left" class="w-72 bg-sidebar p-0">
					<AppSidebar {projects} {activeJobs} {host} onNavigate={() => (mobileOpen = false)} />
				</Sheet.Content>
			</Sheet.Root>
			<a href="/"><Logo /></a>
		</div>
		<main class="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
			{@render children()}
		</main>
	</div>
</div>

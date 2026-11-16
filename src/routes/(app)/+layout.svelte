<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import AppShell from '$lib/components/templates/app-shell.svelte';
	import CommandPalette from '$lib/components/organisms/command-palette.svelte';
	import { deferred } from '$lib/deferred.svelte';
	import { coalesce, connectLive, onJobChange } from '$lib/live.svelte';

	let { data, children } = $props();
	const host = deferred(() => data.host);

	// Barre latérale (jobs actifs, statuts des projets) : rafraîchie à chaque changement de job.
	const refreshShell = coalesce(() => invalidate('forge:shell'));
	onJobChange(refreshShell);
	onMount(() => connectLive());
</script>

<CommandPalette projects={data.projects} user={data.user} />

<AppShell mode={data.mode} dryRun={data.dryRun} projects={data.projects} activeJobs={data.activeJobs} host={host.value ?? null} user={data.user}>
	{@render children()}
</AppShell>

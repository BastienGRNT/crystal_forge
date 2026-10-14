<script lang="ts">
	import AppShell from '$lib/components/templates/app-shell.svelte';
	import { deferred } from '$lib/deferred.svelte';

	let { data, children } = $props();
	const host = deferred(() => data.host);
</script>

<AppShell mode={data.mode} dryRun={data.dryRun} projects={data.projects} activeJobs={data.activeJobs} host={host.value ?? null}>
	{@render children()}
</AppShell>

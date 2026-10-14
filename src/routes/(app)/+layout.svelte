<script lang="ts">
	import AppShell from '$lib/components/templates/app-shell.svelte';

	let { data, children } = $props();
</script>

<AppShell mode={data.mode} dryRun={data.dryRun} projects={data.projects} activeJobs={data.activeJobs} host={data.host}>
	{@render children()}
</AppShell>

<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import PageHeader from '$lib/components/molecules/page-header.svelte';
	import JobList from '$lib/components/organisms/job-list.svelte';

	let { data } = $props();
	onMount(() => {
		const t = setInterval(() => void invalidate('forge:jobs'), 4000);
		return () => clearInterval(t);
	});
</script>

<svelte:head><title>Jobs · Forge</title></svelte:head>

<PageHeader title="Jobs" description="Chaque action qui écrit quelque part (Proxmox, GitHub, OVH, NPM, SSH) passe par un job journalisé, reprenable et annulable." />
<JobList jobs={data.jobs} />

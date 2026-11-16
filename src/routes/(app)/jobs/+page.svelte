<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { coalesce, onJobChange } from '$lib/live.svelte';
	import PageHeader from '$lib/components/molecules/page-header.svelte';
	import JobList from '$lib/components/organisms/job-list.svelte';

	let { data } = $props();
	// Temps réel : la liste se recharge à chaque changement de statut d'un job.
	onJobChange(coalesce(() => invalidate('forge:jobs')));
</script>

<svelte:head><title>Jobs · Forge</title></svelte:head>

<PageHeader title="Jobs" description="Chaque action qui écrit quelque part (Proxmox, GitHub, OVH, NPM, SSH) passe par un job journalisé, reprenable et annulable." />
<JobList jobs={data.jobs} />

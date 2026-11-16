<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import AppShell from '$lib/components/templates/app-shell.svelte';
	import CommandPalette from '$lib/components/organisms/command-palette.svelte';
	import { deferred } from '$lib/deferred.svelte';
	import { coalesce, connectLive, onJobChange } from '$lib/live.svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';

	let { data, children } = $props();
	const host = deferred(() => data.host);

	// Barre latérale (jobs actifs, statuts des projets) : rafraîchie à chaque changement de job.
	const refreshShell = coalesce(() => invalidate('forge:shell'));
	onJobChange(refreshShell);

	// Fin d'un job : une notification discrète, où que l'on soit (sauf sur la page du job elle-même).
	const labels = new Map<number, string>();
	$effect(() => {
		for (const j of data.activeJobList) labels.set(j.id, `${j.label}${j.project ? ` · ${j.project.name}` : ''}`);
	});
	onJobChange((e) => {
		if (e.status !== 'succeeded' && e.status !== 'failed') return;
		if (page.url.pathname === `/jobs/${e.id}`) return;
		const name = labels.get(e.id) ?? `Job #${e.id}${e.slug ? ` · ${e.slug}` : ''}`;
		const action = { label: 'Voir', onClick: () => void goto(`/jobs/${e.id}`) };
		if (e.status === 'succeeded') toast.success(`${name} : terminé`, { action });
		else toast.error(`${name} : échec`, { action, duration: 10_000 });
	});
	onMount(() => connectLive());
</script>

<CommandPalette projects={data.projects} user={data.user} />

<AppShell mode={data.mode} dryRun={data.dryRun} projects={data.projects} spaces={data.spaces} notifications={data.notifications} activeJobs={data.activeJobs} activeJobList={data.activeJobList} host={host.value ?? null} user={data.user}>
	{@render children()}
</AppShell>

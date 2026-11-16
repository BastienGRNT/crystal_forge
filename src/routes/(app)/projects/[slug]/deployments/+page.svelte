<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import { coalesce, onJobChange } from '$lib/live.svelte';
	import { toast } from 'svelte-sonner';
	import Rocket from '@lucide/svelte/icons/rocket';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import Hammer from '@lucide/svelte/icons/hammer';
	import SectionCard from '$lib/components/molecules/section-card.svelte';
	import EmptyState from '$lib/components/molecules/empty-state.svelte';
	import RunsTable from '$lib/components/organisms/runs-table.svelte';
	import JobList from '$lib/components/organisms/job-list.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import * as Alert from '$lib/components/atoms/ui/alert';
	import Spinner from '$lib/components/atoms/spinner.svelte';

	let { data } = $props();
	// Un job de ce projet change de statut (lancé ici, ailleurs ou automatiquement) : on recharge.
	const reloadRuns = coalesce(() => invalidate('forge:runs'));
	onJobChange((e) => {
		if (e.slug === data.project.slug) reloadRuns();
	});
	let pending = $state(false);
	onMount(() => {
		const t = setInterval(() => {
			if (data.runs.some((r) => r.status !== 'completed')) void invalidate('forge:runs');
		}, 4000);
		return () => clearInterval(t);
	});
</script>

<svelte:head><title>Déploiements · {data.project.name} · Forge</title></svelte:head>

<div class="space-y-8">
	{#if data.build.buildMode === 'builder'}
		<SectionCard title="Déploiement par Forge" description="Forge vérifie {data.project.branch} toutes les minutes ; les images sont construites sur le CT de build puis envoyées dans le CT du projet." icon={Hammer}>
			{#snippet actions()}
				<form method="POST" action="?/redeploy" use:enhance={() => { pending = true; return async ({ result, update }) => { pending = false; if (result.type === 'failure') toast.error((result.data as { error?: string })?.error ?? 'Impossible de redéployer'); await update(); }; }}>
					<Button type="submit" size="sm" disabled={pending || !!data.activeJob || data.project.status === 'draft'}>{#if pending}<Spinner />{:else}<Rocket />{/if} Redéployer</Button>
				</form>
			{/snippet}
			<div class="flex flex-wrap items-center justify-between gap-3 text-sm">
				<p>Commit en ligne : {#if data.build.deployedSha}<span class="font-mono">{data.build.deployedSha.slice(0, 7)}</span>{:else}<span class="text-muted-foreground">inconnu (noté au prochain passage)</span>{/if}</p>
				<form method="POST" action="?/autoDeploy" use:enhance class="flex items-center gap-2">
					<input type="hidden" name="on" value={data.build.autoDeploy ? '0' : '1'} />
					<span class={data.build.autoDeploy ? 'text-success' : 'text-muted-foreground'}>Déploiement automatique à chaque push : {data.build.autoDeploy ? 'activé' : 'désactivé'}</span>
					<Button type="submit" size="sm" variant="outline">{data.build.autoDeploy ? 'Désactiver' : 'Activer'}</Button>
				</form>
			</div>
		</SectionCard>
	{:else}
	{#if data.build.hasCt}
		<Alert.Root class="border-warning/40">
			<Hammer class="text-warning" />
			<Alert.Description>
				<p>Ce projet utilise encore un runner GitHub dans son CT (il y construit ses images, ce qui consomme de la RAM et du disque).</p>
				<p class="mt-1 text-xs text-muted-foreground">Le passage redéploie le projet par le CT de build, puis retire runner, workflow, secret et variables du dépôt et nettoie le CT. Les données ne bougent pas ; en cas d'échec, rien n'est retiré.</p>
				<form method="POST" action="?/migrate" use:enhance class="mt-2"><Button type="submit" size="sm" disabled={!!data.activeJob}><Hammer /> Passer sur le CT de build</Button></form>
			</Alert.Description>
		</Alert.Root>
	{/if}
	<SectionCard title="Runs GitHub Actions" description="Workflow forge-deploy.yml — déclenché à chaque push sur {data.project.branch} ou manuellement." icon={GitBranch} bodyClass="p-0">
		{#snippet actions()}
			<form
				method="POST"
				action="?/redeploy"
				use:enhance={() => {
					pending = true;
					return async ({ result, update }) => {
						pending = false;
						if (result.type === 'failure') toast.error((result.data as { error?: string })?.error ?? 'Impossible de redéployer');
						await update();
					};
				}}
			>
				<Button type="submit" size="sm" disabled={pending || !!data.activeJob || data.project.status === 'draft'}>
					{#if pending}<Spinner />{:else}<Rocket />{/if}
					Redéployer
				</Button>
			</form>
		{/snippet}
		<div class="p-4">
			{#if data.runsError}
				<Alert.Root variant="destructive"><Alert.Description>{data.runsError}</Alert.Description></Alert.Root>
			{:else if data.runs.length === 0}
				<EmptyState icon={GitBranch} title="Aucun run pour l'instant" description="Le premier run est lancé à la fin du déploiement initial." />
			{:else}
				<RunsTable runs={data.runs} slug={data.project.slug} />
			{/if}
		</div>
	</SectionCard>
	{/if}

	<section class="space-y-3">
		<h2 class="flex items-center gap-2 text-sm font-semibold"><ListChecks class="size-4 text-muted-foreground" /> Jobs Forge du projet</h2>
		<JobList jobs={data.jobs} showProject={false} />
	</section>
</div>

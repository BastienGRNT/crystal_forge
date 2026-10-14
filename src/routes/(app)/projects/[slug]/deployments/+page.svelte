<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import Rocket from '@lucide/svelte/icons/rocket';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import SectionCard from '$lib/components/molecules/section-card.svelte';
	import EmptyState from '$lib/components/molecules/empty-state.svelte';
	import RunsTable from '$lib/components/organisms/runs-table.svelte';
	import JobList from '$lib/components/organisms/job-list.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import * as Alert from '$lib/components/atoms/ui/alert';
	import Spinner from '$lib/components/atoms/spinner.svelte';

	let { data } = $props();
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

	<section class="space-y-3">
		<h2 class="flex items-center gap-2 text-sm font-semibold"><ListChecks class="size-4 text-muted-foreground" /> Jobs Forge du projet</h2>
		<JobList jobs={data.jobs} showProject={false} />
	</section>
</div>

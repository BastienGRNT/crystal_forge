<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import StatusBadge from '$lib/components/molecules/status-badge.svelte';
	import RelativeTime from '$lib/components/molecules/relative-time.svelte';
	import EmptyState from '$lib/components/molecules/empty-state.svelte';
	import { Badge } from '$lib/components/atoms/ui/badge';
	import { duration } from '$lib/format';
	import type { JobSummary } from '$server/application/use-cases/jobs';

	let { jobs, showProject = true }: { jobs: JobSummary[]; showProject?: boolean } = $props();
</script>

{#if jobs.length === 0}
	<EmptyState icon={ListChecks} title="Aucun job" description="Les déploiements et actions sur les conteneurs apparaîtront ici." />
{:else}
	<ul class="divide-y overflow-hidden rounded-xl border bg-card">
		{#each jobs as j (j.id)}
			<li>
				<a href="/jobs/{j.id}" class="group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-accent/40">
					<span class="w-12 shrink-0 font-mono text-xs text-muted-foreground">#{j.id}</span>
					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-2">
							<span class="text-sm font-medium">{j.label}</span>
							{#if showProject && j.project}<span class="text-sm text-muted-foreground">· {j.project.name}</span>{/if}
							{#if j.dryRun}<Badge variant="outline" class="h-4.5 border-warning/40 px-1.5 text-[10px] text-warning">DRY-RUN</Badge>{/if}
						</div>
						<p class="mt-0.5 truncate text-xs text-muted-foreground">
							<RelativeTime value={j.createdAt} />
							{#if j.startedAt}· {duration((j.finishedAt ?? Date.now()) - j.startedAt)}{/if}
							{#if j.currentStep && j.status !== 'succeeded'}· étape « {j.currentStep} »{/if}
							{#if j.error && j.status === 'failed'}· <span class="text-danger">{j.error}</span>{/if}
						</p>
					</div>
					<StatusBadge status={j.status} />
					<ChevronRight class="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
				</a>
			</li>
		{/each}
	</ul>
{/if}

<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import GitCommitHorizontal from '@lucide/svelte/icons/git-commit-horizontal';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import CircleDashed from '@lucide/svelte/icons/circle-dashed';
	import CircleMinus from '@lucide/svelte/icons/circle-minus';
	import StatusBadge from '$lib/components/molecules/status-badge.svelte';
	import RelativeTime from '$lib/components/molecules/relative-time.svelte';
	import CodeBlock from '$lib/components/molecules/code-block.svelte';
	import Spinner from '$lib/components/atoms/spinner.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import { runStatus } from '$lib/status';
	import { duration } from '$lib/format';
	import { cn } from '$lib/utils';
	import type { GhRun, GhRunJob } from '$server/application/ports';

	let { runs, slug }: { runs: GhRun[]; slug: string } = $props();
	let openId = $state<number | null>(null);
	let detail = $state<{ jobs: GhRunJob[]; logs: { jobId: number; text: string }[] } | null>(null);
	let loading = $state(false);

	async function toggle(id: number) {
		if (openId === id) {
			openId = null;
			return;
		}
		openId = id;
		detail = null;
		loading = true;
		const res = await fetch(`/api/projects/${slug}/runs/${id}`);
		detail = res.ok ? await res.json() : null;
		loading = false;
	}
	const EVENT: Record<string, string> = { push: 'push', workflow_dispatch: 'manuel' };
</script>

<ul class="divide-y overflow-hidden rounded-xl border bg-card">
	{#each runs as run (run.id)}
		{@const st = runStatus(run.status, run.conclusion)}
		<li>
			<button type="button" class="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-accent/40" onclick={() => toggle(run.id)}>
				<GitCommitHorizontal class="size-4 shrink-0 text-muted-foreground" />
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-medium">{run.commitMessage ?? run.name}</p>
					<p class="mt-0.5 text-xs text-muted-foreground">
						#{run.runNumber} · {EVENT[run.event] ?? run.event} · <span class="font-mono">{run.headSha.slice(0, 7)}</span> · {run.actor ?? '—'} ·
						<RelativeTime value={run.createdAt} />
						{#if run.status === 'completed'}· {duration(Date.parse(run.updatedAt) - Date.parse(run.createdAt))}{/if}
					</p>
				</div>
				<StatusBadge info={st} />
				<ChevronDown class={cn('size-4 shrink-0 text-muted-foreground transition-transform', openId === run.id && 'rotate-180')} />
			</button>
			{#if openId === run.id}
				<div class="space-y-4 border-t bg-muted/20 px-4 py-4">
					{#if loading}
						<p class="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Chargement…</p>
					{:else if detail}
						{#each detail.jobs as job (job.id)}
							<div class="space-y-3">
								<div class="flex items-center justify-between">
									<p class="text-sm font-medium">{job.name}</p>
									<Button variant="ghost" size="xs" href={run.htmlUrl} target="_blank" rel="noreferrer">GitHub <ExternalLink /></Button>
								</div>
								<ol class="grid gap-1 sm:grid-cols-2">
									{#each job.steps as s (s.number)}
										<li class="flex items-center gap-2 text-xs">
											{#if s.conclusion === 'success'}<CircleCheck class="size-3.5 text-success" />
											{:else if s.conclusion === 'failure'}<CircleX class="size-3.5 text-danger" />
											{:else if s.status === 'in_progress'}<Spinner class="size-3.5 text-info" />
											{:else if s.conclusion === 'skipped'}<CircleMinus class="size-3.5 text-muted-foreground" />
											{:else}<CircleDashed class="size-3.5 text-muted-foreground" />{/if}
											<span class={s.conclusion === 'failure' ? 'text-danger' : ''}>{s.name}</span>
										</li>
									{/each}
								</ol>
								{#if detail.logs.find((l) => l.jobId === job.id)?.text}
									<CodeBlock code={detail.logs.find((l) => l.jobId === job.id)?.text ?? ''} title="logs · {job.name}" maxHeight="22rem" />
								{/if}
							</div>
						{/each}
					{:else}
						<p class="text-sm text-danger">Impossible de charger le détail du run.</p>
					{/if}
				</div>
			{/if}
		</li>
	{/each}
</ul>

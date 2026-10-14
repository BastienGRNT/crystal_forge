<script lang="ts">
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import CircleDashed from '@lucide/svelte/icons/circle-dashed';
	import CirclePause from '@lucide/svelte/icons/circle-pause';
	import CircleMinus from '@lucide/svelte/icons/circle-minus';
	import Spinner from '$lib/components/atoms/spinner.svelte';
	import { duration } from '$lib/format';
	import { cn } from '$lib/utils';

	interface Step {
		key: string;
		label: string;
		status: string;
		error: string | null;
		startedAt: number | null;
		finishedAt: number | null;
	}
	let {
		steps,
		selected = null,
		onSelect,
		now
	}: { steps: Step[]; selected?: string | null; onSelect?: (key: string | null) => void; now: number } = $props();
</script>

<ol class="relative space-y-1">
	{#each steps as step, i (step.key)}
		{@const active = selected === step.key}
		<li class="relative">
			{#if i < steps.length - 1}
				<span
					class={cn('absolute top-8 left-[17px] h-[calc(100%-1.25rem)] w-px', step.status === 'succeeded' ? 'bg-success/40' : 'bg-border')}
					aria-hidden="true"
				></span>
			{/if}
			<button
				type="button"
				onclick={() => onSelect?.(active ? null : step.key)}
				class={cn('flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors', active ? 'bg-accent' : 'hover:bg-accent/50')}
			>
				<span class="relative z-10 grid size-5 shrink-0 place-items-center rounded-full bg-card">
					{#if step.status === 'succeeded'}<CircleCheck class="size-5 text-success" />
					{:else if step.status === 'failed'}<CircleX class="size-5 text-danger" />
					{:else if step.status === 'running'}<Spinner class="size-5 text-info" />
					{:else if step.status === 'awaiting_input'}<CirclePause class="size-5 text-warning" />
					{:else if step.status === 'skipped'}<CircleMinus class="size-5 text-muted-foreground" />
					{:else}<CircleDashed class="size-5 text-muted-foreground/60" />{/if}
				</span>
				<span class="min-w-0 flex-1">
					<span class="flex items-center justify-between gap-2">
						<span class={cn('text-sm font-medium', step.status === 'pending' && 'text-muted-foreground')}>{step.label}</span>
						<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
							{#if step.startedAt && step.finishedAt}{duration(step.finishedAt - step.startedAt)}
							{:else if step.startedAt && step.status === 'running'}{duration(now - step.startedAt)}{/if}
						</span>
					</span>
					{#if step.error}<span class="mt-1 line-clamp-3 block text-xs break-words text-danger">{step.error}</span>{/if}
				</span>
			</button>
		</li>
	{/each}
</ol>

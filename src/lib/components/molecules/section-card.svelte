<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	let {
		title,
		description,
		icon: Icon,
		actions,
		footer,
		children,
		class: className = '',
		bodyClass = ''
	}: {
		title?: string;
		description?: string;
		icon?: Component<{ class?: string }>;
		actions?: Snippet;
		footer?: Snippet;
		children: Snippet;
		class?: string;
		bodyClass?: string;
	} = $props();
</script>

<section class={cn('overflow-hidden rounded-lg border bg-card text-card-foreground', className)}>
	{#if title || actions}
		<div class="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
			<div class="flex min-w-0 items-start gap-2.5">
				{#if Icon}
					<div class="mt-px grid size-6 shrink-0 place-items-center rounded-md border bg-foreground/[0.03] text-muted-foreground"><Icon class="size-3.5" /></div>
				{/if}
				<div class="min-w-0">
					{#if title}<h2 class="text-[13px] leading-6 font-semibold">{title}</h2>{/if}
					{#if description}<p class="text-xs text-muted-foreground">{description}</p>{/if}
				</div>
			</div>
			{#if actions}<div class="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">{@render actions()}</div>{/if}
		</div>
	{/if}
	<div class={cn('px-4 py-4', bodyClass)}>{@render children()}</div>
	{#if footer}<div class="flex flex-wrap items-center justify-end gap-2 border-t bg-foreground/[0.02] px-4 py-2.5">{@render footer()}</div>{/if}
</section>

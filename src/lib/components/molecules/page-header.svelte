<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		description,
		eyebrow,
		actions,
		children
	}: { title: string; description?: string; eyebrow?: Snippet; actions?: Snippet; children?: Snippet } = $props();
</script>

<header class="flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between">
	<div class="min-w-0 space-y-1.5">
		{#if eyebrow}<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{@render eyebrow()}</div>{/if}
		<h1 class="truncate text-2xl font-semibold tracking-tight">{title}</h1>
		{#if description}<p class="max-w-2xl text-sm text-muted-foreground text-balance">{description}</p>{/if}
		{@render children?.()}
	</div>
	{#if actions}<div class="flex shrink-0 flex-wrap items-center gap-2">{@render actions()}</div>{/if}
</header>

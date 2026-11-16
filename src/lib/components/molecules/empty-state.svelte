<script lang="ts">
	import type { Component, Snippet } from 'svelte';

	let {
		icon: Icon,
		title,
		description,
		children
	}: { icon?: Component<{ class?: string }>; title: string; description?: string; children?: Snippet } = $props();
</script>

<div class="bg-grid relative flex flex-col items-center justify-center gap-3 overflow-hidden rounded-lg border border-dashed px-6 py-14 text-center">
	{#if Icon}
		<div class="grid size-10 place-items-center rounded-md border bg-card text-muted-foreground shadow-sm"><Icon class="size-5" /></div>
	{/if}
	<div class="space-y-1">
		<p class="font-medium">{title}</p>
		{#if description}<p class="max-w-sm text-sm text-muted-foreground text-balance">{description}</p>{/if}
	</div>
	{@render children?.()}
</div>

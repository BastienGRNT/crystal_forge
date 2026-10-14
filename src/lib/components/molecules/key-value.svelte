<script lang="ts">
	import type { Snippet } from 'svelte';
	let { label, children, mono = false }: { label: string; children: Snippet; mono?: boolean } = $props();
</script>

<div class="flex min-w-0 items-start justify-between gap-4 py-2 text-sm">
	<dt class="shrink-0 text-muted-foreground">{label}</dt>
	<dd class={['min-w-0 text-right', mono ? 'font-mono text-[13px] break-all' : 'break-words']}>{@render children()}</dd>
</div>

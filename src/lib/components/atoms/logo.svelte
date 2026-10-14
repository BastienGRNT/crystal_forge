<script lang="ts">
	import { cn } from '$lib/utils';

	let { class: className = '', withText = true }: { class?: string; withText?: boolean } = $props();
</script>

<span class={cn('inline-flex items-center gap-2.5 font-semibold tracking-tight', className)}>
	<span class="relative grid size-7 place-items-center rounded-lg bg-gradient-to-br from-ember to-[color-mix(in_oklch,var(--ember),black_30%)] shadow-[0_0_24px_-6px_var(--ember)]">
		<svg viewBox="0 0 24 24" class="size-4 text-ember-foreground" fill="currentColor" aria-hidden="true">
			<path d="M3 8h12.5a3 3 0 0 1 0 6H14v2.5h1.5V19h-8v-2.5H9V14H4.5A2.5 2.5 0 0 1 2 11.5v-2A1.5 1.5 0 0 1 3 8Z" />
			<path d="M17.5 5.5 19 4M20 8.5h1.6M15 4.4V2.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" />
		</svg>
	</span>
	{#if withText}<span class="text-[15px]">Forge</span>{/if}
</span>

<script lang="ts">
	import { spaceHex, spaceIcon } from '$lib/spaces';
	import { cn } from '$lib/utils';

	let { space, size = 'sm', label = true, class: className = '' }: { space: { name: string; color: string; icon: string }; size?: 'xs' | 'sm' | 'md'; label?: boolean; class?: string } = $props();
	const Icon = $derived(spaceIcon(space.icon));
	const hex = $derived(spaceHex(space.color));
</script>

<span class={cn('inline-flex min-w-0 items-center gap-1.5', className)} title={space.name}>
	<span
		class={cn('grid shrink-0 place-items-center rounded-[5px]', size === 'xs' ? 'size-4' : size === 'sm' ? 'size-5' : 'size-7 rounded-md')}
		style="background: color-mix(in oklab, {hex} 18%, transparent); color: {hex}; box-shadow: inset 0 0 0 1px color-mix(in oklab, {hex} 35%, transparent)"
	>
		<Icon class={size === 'md' ? 'size-4' : size === 'sm' ? 'size-3' : 'size-2.5'} />
	</span>
	{#if label}<span class="truncate">{space.name}</span>{/if}
</span>

<script lang="ts">
	import type { Component } from 'svelte';
	import Meter from '$lib/components/atoms/meter.svelte';
	import { usageTone, TONE_TEXT } from '$lib/status';
	import { cn } from '$lib/utils';

	let {
		label,
		value,
		detail,
		ratio,
		icon: Icon,
		hint,
		class: className = ''
	}: {
		label: string;
		value: string;
		detail?: string;
		ratio: number;
		icon?: Component<{ class?: string }>;
		hint?: string;
		class?: string;
	} = $props();
	const tone = $derived(usageTone(ratio));
</script>

<div class={cn('flex flex-col gap-2.5', className)}>
	<div class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
		<span class="inline-flex items-center gap-1.5 font-medium">
			{#if Icon}<Icon class="size-3.5" />{/if}
			{label}
		</span>
		{#if hint}<span class={cn('font-medium', TONE_TEXT[tone])}>{hint}</span>{/if}
	</div>
	<div class="flex items-baseline gap-1.5">
		<span class="text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
		{#if detail}<span class="text-xs text-muted-foreground tabular-nums">{detail}</span>{/if}
	</div>
	<Meter value={ratio} />
</div>

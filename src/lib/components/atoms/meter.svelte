<script lang="ts">
	import { cn } from '$lib/utils';
	import { TONE_BG, usageTone, type Tone } from '$lib/status';

	let {
		value,
		tone,
		class: className = '',
		size = 'md'
	}: { value: number; tone?: Tone; class?: string; size?: 'sm' | 'md' } = $props();

	const ratio = $derived(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)));
	const t = $derived(tone ?? usageTone(ratio));
</script>

<div
	class={cn('w-full overflow-hidden rounded-full bg-muted', size === 'sm' ? 'h-1' : 'h-1.5', className)}
	role="progressbar"
	aria-valuemin={0}
	aria-valuemax={100}
	aria-valuenow={Math.round(ratio * 100)}
>
	<div class={cn('h-full rounded-full transition-[width] duration-700 ease-out', TONE_BG[t])} style:width="{ratio * 100}%"></div>
</div>

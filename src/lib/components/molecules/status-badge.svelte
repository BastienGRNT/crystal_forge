<script lang="ts">
	import { cn } from '$lib/utils';
	import { statusInfo, TONE_SOFT, type StatusInfo } from '$lib/status';
	import StatusDot from '$lib/components/atoms/status-dot.svelte';

	let {
		status,
		info,
		class: className = ''
	}: { status?: string | null; info?: StatusInfo; class?: string } = $props();

	const s = $derived(info ?? statusInfo(status));
</script>

<span class={cn('inline-flex h-5.5 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap ring-1 ring-inset', TONE_SOFT[s.tone], className)}>
	<StatusDot tone={s.tone} pulse={s.pulse} class="size-1.5" />
	{s.label}
</span>

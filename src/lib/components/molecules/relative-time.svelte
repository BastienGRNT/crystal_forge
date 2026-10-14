<script lang="ts">
	import { onMount } from 'svelte';
	import { dateTime, relativeTime } from '$lib/format';

	let { value }: { value: string | number | null | undefined } = $props();
	let tick = $state(0);
	onMount(() => {
		const t = setInterval(() => tick++, 30_000);
		return () => clearInterval(t);
	});
	const text = $derived.by(() => {
		void tick;
		return relativeTime(value);
	});
</script>

<time datetime={value ? new Date(value).toISOString() : undefined} title={dateTime(value)}>{text}</time>

<script lang="ts">
	import '../app.css';
	import { ModeWatcher } from 'mode-watcher';
	import { Toaster } from '$lib/components/atoms/ui/sonner';
	import * as Tooltip from '$lib/components/atoms/ui/tooltip';

	let { children } = $props();
</script>

<svelte:head>
	<title>Forge</title>
</svelte:head>

<ModeWatcher defaultMode="dark" />
<Toaster richColors closeButton position="bottom-right" />
<Tooltip.Provider delayDuration={200}>
	{@render children()}
</Tooltip.Provider>

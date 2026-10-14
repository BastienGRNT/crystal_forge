<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { cn } from '$lib/utils';

	let { class: className = '' }: { class?: string } = $props();
</script>

<LoaderCircle class={cn('size-4 animate-spin', className)} aria-label="Chargement" />

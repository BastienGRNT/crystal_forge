<script lang="ts">
	import Copy from '@lucide/svelte/icons/copy';
	import Check from '@lucide/svelte/icons/check';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/atoms/ui/button';

	let { value, label = 'Copier', size = 'icon-sm' }: { value: string; label?: string; size?: 'icon-sm' | 'icon-xs' | 'sm' } = $props();
	let copied = $state(false);

	async function copy() {
		try {
			await navigator.clipboard.writeText(value);
			copied = true;
			toast.success('Copié dans le presse-papiers');
			setTimeout(() => (copied = false), 1500);
		} catch {
			toast.error('Copie impossible (navigateur non sécurisé ?)');
		}
	}
</script>

<Button variant="ghost" {size} onclick={copy} aria-label={label} title={label}>
	{#if copied}<Check class="text-success" />{:else}<Copy />{/if}
	{#if size === 'sm'}{label}{/if}
</Button>

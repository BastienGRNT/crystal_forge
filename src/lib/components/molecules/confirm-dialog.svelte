<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as AlertDialog from '$lib/components/atoms/ui/alert-dialog';
	import { Input } from '$lib/components/atoms/ui/input';
	import { Label } from '$lib/components/atoms/ui/label';
	import { buttonVariants } from '$lib/components/atoms/ui/button';

	let {
		open = $bindable(false),
		title,
		description,
		confirmLabel = 'Confirmer',
		destructive = false,
		typeToConfirm,
		onConfirm,
		children
	}: {
		open?: boolean;
		title: string;
		description?: string;
		confirmLabel?: string;
		destructive?: boolean;
		/** Texte à retaper pour activer le bouton (double confirmation). */
		typeToConfirm?: string;
		onConfirm: () => void;
		children?: Snippet;
	} = $props();

	let typed = $state('');
	const ok = $derived(!typeToConfirm || typed.trim() === typeToConfirm);
	$effect(() => {
		if (!open) typed = '';
	});
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{title}</AlertDialog.Title>
			{#if description}<AlertDialog.Description>{description}</AlertDialog.Description>{/if}
		</AlertDialog.Header>
		{@render children?.()}
		{#if typeToConfirm}
			<div class="space-y-2">
				<Label for="confirm-typed">Tapez <code class="rounded bg-muted px-1 py-0.5 text-foreground">{typeToConfirm}</code> pour confirmer</Label>
				<Input id="confirm-typed" bind:value={typed} autocomplete="off" spellcheck={false} />
			</div>
		{/if}
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Annuler</AlertDialog.Cancel>
			<AlertDialog.Action
				disabled={!ok}
				class={destructive ? buttonVariants({ variant: 'destructive' }) : ''}
				onclick={() => {
					if (!ok) return;
					open = false;
					onConfirm();
				}}>{confirmLabel}</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

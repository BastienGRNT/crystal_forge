<script lang="ts">
	import Lock from '@lucide/svelte/icons/lock';
	import { Input } from '$lib/components/atoms/ui/input';
	import { Label } from '$lib/components/atoms/ui/label';
	import { Textarea } from '$lib/components/atoms/ui/textarea';

	let {
		name,
		label,
		value = '',
		help,
		secret = false,
		secretSet = false,
		multiline = false,
		mono = true,
		placeholder = ''
	}: {
		name: string;
		label: string;
		value?: string;
		help?: string;
		secret?: boolean;
		secretSet?: boolean;
		multiline?: boolean;
		mono?: boolean;
		placeholder?: string;
	} = $props();
	const id = $derived(`f-${name.replace(/\./g, '-')}`);
</script>

<div class="space-y-1.5">
	<Label for={id} class="flex items-center gap-1.5">
		{label}
		{#if secret}
			<Lock class="size-3 text-muted-foreground" />
			{#if secretSet}<span class="text-xs font-normal text-success">défini</span>{:else}<span class="text-xs font-normal text-muted-foreground">non défini</span>{/if}
		{/if}
	</Label>
	{#if multiline}
		<Textarea {id} {name} {value} {placeholder} rows={4} spellcheck={false} class={mono ? 'font-mono text-xs' : ''} />
	{:else if secret}
		<Input {id} {name} type="password" autocomplete="new-password" placeholder={secretSet ? '•••••••• (laisser vide pour ne pas changer)' : placeholder} class="font-mono" />
	{:else}
		<Input {id} {name} {value} {placeholder} spellcheck={false} class={mono ? 'font-mono' : ''} />
	{/if}
	{#if help}<p class="text-xs text-muted-foreground">{help}</p>{/if}
</div>

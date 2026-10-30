<script lang="ts">
	import { enhance } from '$app/forms';
	import Save from '@lucide/svelte/icons/save';
	import PageHeader from '$lib/components/molecules/page-header.svelte';
	import SectionCard from '$lib/components/molecules/section-card.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import { Input } from '$lib/components/atoms/ui/input';
	import { Label } from '$lib/components/atoms/ui/label';
	import * as Alert from '$lib/components/atoms/ui/alert';

	let { data, form } = $props();
</script>

<svelte:head><title>Mon compte · Forge</title></svelte:head>

<PageHeader title="Mon compte" description="Connecté en tant que {data.username} ({data.role === 'admin' ? 'administrateur' : 'collaborateur'})." />

<form method="POST" action="?/password" use:enhance class="max-w-3xl">
	<SectionCard title="Mot de passe" description="Changer le mot de passe déconnecte toutes vos sessions.">
		{#if form?.error}
			<Alert.Root variant="destructive" class="mb-4"><Alert.Description>{form.error}</Alert.Description></Alert.Root>
		{/if}
		<div class="grid gap-4 md:grid-cols-3">
			<div class="space-y-1.5"><Label for="current">Actuel</Label><Input id="current" name="current" type="password" autocomplete="current-password" required /></div>
			<div class="space-y-1.5"><Label for="next">Nouveau</Label><Input id="next" name="next" type="password" autocomplete="new-password" minlength={12} required /></div>
			<div class="space-y-1.5"><Label for="confirm">Confirmation</Label><Input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength={12} required /></div>
		</div>
		{#snippet footer()}<Button type="submit" size="sm"><Save /> Changer le mot de passe</Button>{/snippet}
	</SectionCard>
</form>

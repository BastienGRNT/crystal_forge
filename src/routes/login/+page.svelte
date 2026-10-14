<script lang="ts">
	import { enhance } from '$app/forms';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import AuthShell from '$lib/components/templates/auth-shell.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import { Input } from '$lib/components/atoms/ui/input';
	import { Label } from '$lib/components/atoms/ui/label';
	import * as Alert from '$lib/components/atoms/ui/alert';
	import Spinner from '$lib/components/atoms/spinner.svelte';

	let { data, form } = $props();
	let pending = $state(false);
</script>

<svelte:head><title>Connexion · Forge</title></svelte:head>

<AuthShell title="Connexion" subtitle="Mini-PaaS pour Proxmox — LXC, runners GitHub, NPM et OVH.">
	<form
		method="POST"
		class="space-y-4"
		use:enhance={() => {
			pending = true;
			return async ({ update }) => {
				await update({ reset: false });
				pending = false;
			};
		}}
	>
		{#if data.justSetUp}
			<Alert.Root><ShieldCheck /><Alert.Description>Compte admin créé. Connectez-vous.</Alert.Description></Alert.Root>
		{/if}
		{#if form?.error}
			<Alert.Root variant="destructive"><Alert.Description>{form.error}</Alert.Description></Alert.Root>
		{/if}
		<div class="space-y-2">
			<Label for="password">Mot de passe administrateur</Label>
			<!-- svelte-ignore a11y_autofocus -->
			<Input id="password" name="password" type="password" required autocomplete="current-password" autofocus />
		</div>
		<Button type="submit" class="w-full" size="lg" disabled={pending}>
			{#if pending}<Spinner />{/if}
			Se connecter
		</Button>
	</form>
	{#snippet footer()}
		Accessible uniquement via Tailscale{#if data.mode === 'mock'} · <span class="text-ember">mode démo</span>{/if}
	{/snippet}
</AuthShell>

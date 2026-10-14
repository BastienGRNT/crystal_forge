<script lang="ts">
	import { enhance } from '$app/forms';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import AuthShell from '$lib/components/templates/auth-shell.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import { Input } from '$lib/components/atoms/ui/input';
	import { Label } from '$lib/components/atoms/ui/label';
	import * as Alert from '$lib/components/atoms/ui/alert';
	import Spinner from '$lib/components/atoms/spinner.svelte';

	let { data, form } = $props();
	let pending = $state(false);
</script>

<svelte:head><title>Installation · Forge</title></svelte:head>

<AuthShell title="Première installation" subtitle="Créez le mot de passe administrateur. Le jeton d'installation est affiché dans les logs du conteneur Forge.">
	<form
		method="POST"
		class="space-y-4"
		use:enhance={() => {
			pending = true;
			return async ({ update }) => {
				await update();
				pending = false;
			};
		}}
	>
		{#if form?.error}
			<Alert.Root variant="destructive"><Alert.Description class="whitespace-pre-line">{form.error}</Alert.Description></Alert.Root>
		{/if}
		{#if data.prefilledToken}
			<Alert.Root>
				<KeyRound />
				<Alert.Title>Mode démo</Alert.Title>
				<Alert.Description>Le jeton est pré-rempli. En production, lisez-le avec <code>docker compose logs forge</code>.</Alert.Description>
			</Alert.Root>
		{/if}
		<div class="space-y-2">
			<Label for="token">Jeton d'installation</Label>
			<Input id="token" name="token" required autocomplete="off" class="font-mono" value={data.prefilledToken ?? ''} />
		</div>
		<div class="space-y-2">
			<Label for="password">Mot de passe admin</Label>
			<Input id="password" name="password" type="password" required minlength={12} autocomplete="new-password" />
			<p class="text-xs text-muted-foreground">12 caractères minimum. Haché avec argon2id.</p>
		</div>
		<div class="space-y-2">
			<Label for="confirm">Confirmation</Label>
			<Input id="confirm" name="confirm" type="password" required minlength={12} autocomplete="new-password" />
		</div>
		<Button type="submit" class="w-full" size="lg" disabled={pending}>
			{#if pending}<Spinner />{/if}
			Créer le compte
		</Button>
	</form>
</AuthShell>

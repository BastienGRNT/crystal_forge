<script lang="ts">
	import { enhance } from '$app/forms';
	import AuthShell from '$lib/components/templates/auth-shell.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import { Input } from '$lib/components/atoms/ui/input';
	import { Label } from '$lib/components/atoms/ui/label';
	import * as Alert from '$lib/components/atoms/ui/alert';
	import Spinner from '$lib/components/atoms/spinner.svelte';

	let { data, form } = $props();
	let pending = $state(false);
</script>

<svelte:head><title>Nouveau mot de passe · Forge</title></svelte:head>

{#if data.username}
	<AuthShell title="Nouveau mot de passe" subtitle="Compte : {data.username}. Ce lien ne fonctionne qu'une fois.">
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
			{#if form?.error}
				<Alert.Root variant="destructive"><Alert.Description>{form.error}</Alert.Description></Alert.Root>
			{/if}
			<div class="space-y-2">
				<Label for="password">Nouveau mot de passe</Label>
				<Input id="password" name="password" type="password" required minlength={12} autocomplete="new-password" />
				<p class="text-xs text-muted-foreground">12 caractères minimum.</p>
			</div>
			<div class="space-y-2">
				<Label for="confirm">Confirmation</Label>
				<Input id="confirm" name="confirm" type="password" required minlength={12} autocomplete="new-password" />
			</div>
			<Button type="submit" class="w-full" size="lg" disabled={pending}>
				{#if pending}<Spinner />{/if}
				Enregistrer
			</Button>
		</form>
	</AuthShell>
{:else}
	<AuthShell title="Lien invalide" subtitle="Ce lien a expiré ou a déjà servi. Demandez-en un nouveau à l'administrateur.">
		<Button href="/login" class="w-full" variant="outline">Retour à la connexion</Button>
	</AuthShell>
{/if}

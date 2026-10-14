<script lang="ts">
	import { enhance } from '$app/forms';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Eye from '@lucide/svelte/icons/eye';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import Save from '@lucide/svelte/icons/save';
	import FileText from '@lucide/svelte/icons/file-text';
	import SectionCard from '$lib/components/molecules/section-card.svelte';
	import RelativeTime from '$lib/components/molecules/relative-time.svelte';
	import EnvEditor from '$lib/components/organisms/env-editor.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import { Input } from '$lib/components/atoms/ui/input';
	import { Label } from '$lib/components/atoms/ui/label';
	import { Checkbox } from '$lib/components/atoms/ui/checkbox';
	import * as Dialog from '$lib/components/atoms/ui/dialog';
	import * as Alert from '$lib/components/atoms/ui/alert';
	import Spinner from '$lib/components/atoms/spinner.svelte';
	import WandSparkles from '@lucide/svelte/icons/wand-sparkles';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import { randomSecret, suggestValue, type EnvTemplate } from '$lib/domain/env-template';
	import { cn } from '$lib/utils';

	let { data, form } = $props();

	let mode = $state<'keys' | 'replace'>('keys');
	let changes = $state<Record<string, string>>({});
	let removed = $state<string[]>([]);
	let added = $state<{ id: number; key: string; value: string }[]>([]);
	let replaceText = $state('');
	let redeploy = $state(true);
	let revealOpen = $state(false);
	let saving = $state(false);

	$effect(() => {
		if (form && 'revealed' in form && typeof form.revealed === 'string') {
			replaceText = form.revealed;
			mode = 'replace';
			revealOpen = false;
		}
	});

	const setJson = $derived(
		JSON.stringify({
			...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== '')),
			...Object.fromEntries(added.filter((a) => a.key.trim()).map((a) => [a.key.trim(), a.value]))
		})
	);
	/** Ajoute en « nouvelles variables » les clés du modèle absentes du .env, préremplies. */
	function addMissing(template: EnvTemplate | null, keys: string[], fqdn: string | null) {
		for (const key of keys) {
			if (added.some((a) => a.key === key)) continue;
			const entry = template?.entries.find((e) => e.key === key);
			const s = entry ? suggestValue(entry, { fqdn, appPort: data.project.appPort, generate: () => randomSecret() }) : null;
			added.push({ id: Date.now() + Math.random(), key, value: s?.value ?? '' });
		}
		mode = 'keys';
	}

	const dirty = $derived(
		mode === 'replace' ? replaceText.trim() !== '' : Object.values(changes).some((v) => v !== '') || removed.length > 0 || added.some((a) => a.key.trim())
	);
</script>

<svelte:head><title>Variables · {data.project.name} · Forge</title></svelte:head>

<div class="space-y-6">
	{#if form && 'saveError' in form && form.saveError}
		<Alert.Root variant="destructive"><Alert.Description class="whitespace-pre-line">{form.saveError}</Alert.Description></Alert.Root>
	{/if}

	{#await data.template then t}
		{#if t.error}
			<p class="text-xs text-muted-foreground">Modèle .env du dépôt illisible : {t.error}</p>
		{:else if t.template || t.check.missing.length}
			<div class={cn('rounded-lg border p-3 text-sm', t.check.missing.length || t.check.unfilled.length ? 'border-info/30 bg-info/5' : 'border-success/30 bg-success/5')}>
				<div class="flex flex-wrap items-start justify-between gap-3">
					<div class="flex min-w-0 items-start gap-2.5">
						<FileText class="mt-0.5 size-4 shrink-0 text-info" />
						<div class="min-w-0 space-y-1">
							<p class="font-medium">
								Comparaison avec {#if t.template}<code class="rounded bg-muted px-1">{t.template.file}</code>{:else}le docker-compose{/if} (branche {data.project.branch})
							</p>
							{#if t.check.missing.length}
								<div class="flex flex-wrap items-center gap-1.5 text-xs">
									<span class="text-muted-foreground">Absentes de votre .env :</span>
									{#each t.check.missing as m (m.key)}<code class={cn('rounded px-1.5 py-0.5', m.from === 'compose' ? 'bg-warning/15 text-warning' : 'bg-muted')}>{m.key}</code>{/each}
								</div>
							{/if}
							{#if t.check.unfilled.length}
								<p class="flex flex-wrap items-center gap-1.5 text-xs text-warning">
									<TriangleAlert class="size-3.5" /> Vides ou à leur valeur d'exemple :
									{#each t.check.unfilled as k (k)}<code class="rounded bg-warning/15 px-1.5 py-0.5">{k}</code>{/each}
								</p>
							{/if}
							{#if !t.check.missing.length && !t.check.unfilled.length}
								<p class="flex items-center gap-1.5 text-xs text-success"><CircleCheck class="size-3.5" /> Votre .env contient toutes les variables attendues.</p>
							{/if}
						</div>
					</div>
					{#if t.check.missing.length}
						<Button size="sm" variant="secondary" onclick={() => addMissing(t.template, t.check.missing.map((m) => m.key), t.fqdn)}>
							<WandSparkles /> Ajouter les {t.check.missing.length} manquante(s)
						</Button>
					{/if}
				</div>
			</div>
		{/if}
	{/await}

	<SectionCard
		title="Fichier .env"
		description="Stocké chiffré dans Forge et envoyé à GitHub dans le secret ENV_FILE. Les valeurs ne sont jamais affichées sans votre mot de passe."
		icon={KeyRound}
	>
		{#snippet actions()}
			<div class="flex rounded-lg border p-0.5">
				<Button variant={mode === 'keys' ? 'secondary' : 'ghost'} size="xs" onclick={() => (mode = 'keys')}>Par clé</Button>
				<Button variant={mode === 'replace' ? 'secondary' : 'ghost'} size="xs" onclick={() => (mode = 'replace')}><FileText /> Fichier complet</Button>
			</div>
			<Button variant="outline" size="sm" onclick={() => (revealOpen = true)} disabled={!data.project.hasEnv}><Eye /> Afficher</Button>
		{/snippet}

		<form
			id="env-form"
			method="POST"
			action="?/save"
			use:enhance={() => {
				saving = true;
				return async ({ update }) => {
					await update({ reset: false });
					saving = false;
				};
			}}
		>
			<input type="hidden" name="mode" value={mode} />
			<input type="hidden" name="set" value={setJson} />
			<input type="hidden" name="remove" value={JSON.stringify(removed)} />
			{#if mode === 'keys'}
				<div class="overflow-hidden rounded-lg border">
					<table class="w-full text-sm">
						<thead class="bg-muted/40 text-xs text-muted-foreground">
							<tr>
								<th class="px-3 py-2 text-left font-medium">Clé</th>
								<th class="hidden px-3 py-2 text-left font-medium sm:table-cell">Valeur actuelle</th>
								<th class="px-3 py-2 text-left font-medium">Nouvelle valeur</th>
								<th class="w-10"></th>
							</tr>
						</thead>
						<tbody class="divide-y">
							{#each data.env.entries as e (e.key)}
								{@const gone = removed.includes(e.key)}
								<tr class={cn(gone && 'bg-danger/5')}>
									<td class={cn('px-3 py-2 font-mono text-[13px]', gone && 'text-danger line-through')}>{e.key}</td>
									<td class="hidden px-3 py-2 font-mono text-xs tracking-widest text-muted-foreground sm:table-cell">{e.masked}</td>
									<td class="px-3 py-1.5">
										<Input
											type="password"
											autocomplete="off"
											placeholder="inchangée"
											class="h-8 font-mono"
											disabled={gone}
											value={changes[e.key] ?? ''}
											oninput={(ev) => (changes[e.key] = (ev.currentTarget as HTMLInputElement).value)}
										/>
									</td>
									<td class="px-2">
										<Button
											variant="ghost"
											size="icon-sm"
											title={gone ? 'Rétablir' : 'Supprimer'}
											onclick={() => (removed = gone ? removed.filter((k) => k !== e.key) : [...removed, e.key])}
										>
											{#if gone}<Undo2 />{:else}<Trash2 class="text-muted-foreground" />{/if}
										</Button>
									</td>
								</tr>
							{/each}
							{#each added as a, i (a.id)}
								<tr class="bg-success/5">
									<td class="px-3 py-1.5"><Input bind:value={a.key} placeholder="NOUVELLE_CLE" class="h-8 font-mono" /></td>
									<td class="hidden px-3 py-2 text-xs text-success sm:table-cell">nouvelle</td>
									<td class="px-3 py-1.5"><Input type="password" bind:value={a.value} autocomplete="off" class="h-8 font-mono" /></td>
									<td class="px-2"><Button variant="ghost" size="icon-sm" onclick={() => added.splice(i, 1)}><Trash2 class="text-muted-foreground" /></Button></td>
								</tr>
							{/each}
							{#if data.env.entries.length === 0 && added.length === 0}
								<tr><td colspan="4" class="px-3 py-8 text-center text-sm text-muted-foreground">Aucune variable.</td></tr>
							{/if}
						</tbody>
					</table>
				</div>
				<Button variant="outline" size="sm" class="mt-3" onclick={() => added.push({ id: Date.now(), key: '', value: '' })}><Plus /> Ajouter une variable</Button>
			{:else}
				<p class="mb-3 text-sm text-muted-foreground">Le contenu ci-dessous remplacera entièrement le .env actuel.</p>
				<EnvEditor bind:value={replaceText} />
			{/if}
		</form>

		{#snippet footer()}
			<div class="flex w-full flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
				<p class="text-xs text-muted-foreground">
					{data.env.entries.length} variable(s){#if data.env.updatedAt} · modifié <RelativeTime value={data.env.updatedAt} />{/if}
				</p>
				<div class="flex items-center gap-4">
					<label class="flex items-center gap-2 text-sm">
						<Checkbox bind:checked={redeploy} name="redeploy" form="env-form" />
						Redéployer ensuite
					</label>
					<Button type="submit" form="env-form" size="sm" disabled={!dirty || saving || !!data.activeJob}>
						{#if saving}<Spinner />{:else}<Save />{/if}
						Enregistrer et mettre à jour ENV_FILE
					</Button>
				</div>
			</div>
		{/snippet}
	</SectionCard>
</div>

<Dialog.Root bind:open={revealOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Afficher le .env en clair</Dialog.Title>
			<Dialog.Description>Confirmez avec votre mot de passe administrateur. Le contenu sera chargé dans l'éditeur « Fichier complet ».</Dialog.Description>
		</Dialog.Header>
		<form method="POST" action="?/reveal" use:enhance={() => async ({ update }) => update({ reset: false })} class="space-y-4">
			{#if form && 'revealError' in form && form.revealError}
				<Alert.Root variant="destructive"><Alert.Description>{form.revealError}</Alert.Description></Alert.Root>
			{/if}
			<div class="space-y-2">
				<Label for="reveal-password">Mot de passe</Label>
				<Input id="reveal-password" name="password" type="password" required autocomplete="current-password" />
			</div>
			<Dialog.Footer><Button type="submit">Afficher</Button></Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

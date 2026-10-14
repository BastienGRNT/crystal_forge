<script lang="ts">
	import { enhance } from '$app/forms';
	import Settings2 from '@lucide/svelte/icons/settings-2';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Archive from '@lucide/svelte/icons/archive';
	import Unlink from '@lucide/svelte/icons/unlink';
	import Save from '@lucide/svelte/icons/save';
	import SectionCard from '$lib/components/molecules/section-card.svelte';
	import KeyValue from '$lib/components/molecules/key-value.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import { Input } from '$lib/components/atoms/ui/input';
	import { Label } from '$lib/components/atoms/ui/label';
	import { Checkbox } from '$lib/components/atoms/ui/checkbox';
	import * as Alert from '$lib/components/atoms/ui/alert';
	import * as AlertDialog from '$lib/components/atoms/ui/alert-dialog';
	import { RESOURCE_LABEL, resourceDisplay } from '$lib/resources';
	import ArrowUpCircle from '@lucide/svelte/icons/circle-arrow-up';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleHelp from '@lucide/svelte/icons/circle-help';
	import Hand from '@lucide/svelte/icons/hand';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { Skeleton } from '$lib/components/atoms/ui/skeleton';
	import DiffView from '$lib/components/molecules/diff-view.svelte';
	import CodeBlock from '$lib/components/molecules/code-block.svelte';
	import { cn } from '$lib/utils';

	let { data, form } = $props();
	const p = $derived(data.project);
	let redeploy = $state(true);
	let deleteOpen = $state(false);
	let mode = $state<'full' | 'forget'>('full');
	let typed = $state('');
</script>

<svelte:head><title>Paramètres · {p.name} · Forge</title></svelte:head>

<div class="space-y-6">
	{#if form?.error}<Alert.Root variant="destructive"><Alert.Description class="whitespace-pre-line">{form.error}</Alert.Description></Alert.Root>{/if}

	<SectionCard title="Application" description="Ces réglages sont des variables de dépôt FORGE_* lues par le workflow." icon={Settings2}>
		<form id="settings-form" method="POST" action="?/update" use:enhance class="grid gap-4 sm:grid-cols-3">
			<div class="space-y-2">
				<Label for="appPort">Port de l'app</Label>
				<Input id="appPort" name="appPort" type="number" value={p.appPort} class="font-mono" />
			</div>
			<div class="space-y-2">
				<Label for="appService">Service principal</Label>
				<Input id="appService" name="appService" value={p.appService} class="font-mono" disabled={p.deployMode === 'dockerfile'} />
			</div>
			<div class="space-y-2">
				<Label for="postDeploy">Commande post-déploiement</Label>
				<Input id="postDeploy" name="postDeploy" value={p.postDeploy ?? ''} placeholder="(aucune)" class="font-mono" />
			</div>
		</form>
		<dl class="mt-5 grid gap-x-8 border-t pt-3 sm:grid-cols-2">
			<KeyValue label="Mode" mono>{p.deployMode}</KeyValue>
			<KeyValue label="Fichier compose" mono>{p.composeFile ?? '.forge-compose.yml (généré)'}</KeyValue>
			<KeyValue label="Dossier de travail" mono>{p.workdir}</KeyValue>
			<KeyValue label="Branche" mono>{p.branch}</KeyValue>
		</dl>
		{#snippet footer()}
			<label class="flex items-center gap-2 text-sm"><Checkbox bind:checked={redeploy} name="redeploy" form="settings-form" /> Redéployer ensuite</label>
			<Button type="submit" form="settings-form" size="sm" disabled={!!data.activeJob}><Save /> Enregistrer</Button>
		{/snippet}
	</SectionCard>

	<SectionCard
		title="Mettre à niveau le projet"
		description="Compare ce que Forge produirait aujourd'hui avec ce qui est en place, puis applique les éléments cochés (le workflow est montré avant tout commit)."
		icon={ArrowUpCircle}
	>
		{#await data.upgrade}
			<div class="space-y-3">{#each Array(4) as _, i (i)}<Skeleton class="h-12 w-full" />{/each}</div>
		{:then items}
			{@const outdated = items.filter((i) => i.status === 'outdated')}
			<form id="upgrade-form" method="POST" action="?/upgrade" use:enhance>
				<ul class="divide-y rounded-lg border">
					{#each items as item (item.key)}
						<li class="space-y-2 px-4 py-3">
							<div class="flex items-start gap-3">
								{#if item.status === 'outdated'}
									<Checkbox name="items" value={item.key} checked class="mt-0.5" />
								{:else if item.status === 'ok'}
									<CircleCheck class="mt-0.5 size-4 shrink-0 text-success" />
								{:else if item.status === 'blocked'}
									<Hand class="mt-0.5 size-4 shrink-0 text-warning" />
								{:else}
									<CircleHelp class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
								{/if}
								<div class="min-w-0 flex-1">
									<p class="text-sm font-medium">{item.label}</p>
									<p class={cn('text-sm break-words', item.status === 'outdated' ? 'text-foreground/80' : 'text-muted-foreground')}>{item.detail}</p>
								</div>
							</div>
							{#if item.diff}
								<details class="group ml-7">
									<summary class="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
										<ChevronRight class="size-3.5 transition-transform group-open:rotate-90" /> Voir les changements
									</summary>
									<div class="mt-2 space-y-2">
										<DiffView lines={item.diff} title=".github/workflows/forge-deploy.yml" />
										{#if item.expected}<CodeBlock code={item.expected} title="Nouvelle version (à reporter vous-même)" maxHeight="16rem" />{/if}
									</div>
								</details>
							{/if}
						</li>
					{/each}
				</ul>
			</form>
			<div class="mt-4 flex items-center justify-end">
				<Button type="submit" form="upgrade-form" size="sm" disabled={outdated.length === 0 || !!data.activeJob}>
					<ArrowUpCircle />
					{outdated.length ? `Mettre à niveau (${outdated.length})` : 'Tout est à jour'}
				</Button>
			</div>
		{/await}
	</SectionCard>

	<SectionCard title="Ressources gérées par Forge" description="Tout ce que Forge a créé pour ce projet. Seules ces ressources peuvent être modifiées ou supprimées par Forge." bodyClass="p-0">
		<ul class="divide-y text-sm">
			{#each data.resources as r (r.type + r.externalId)}
				<li class="flex items-center justify-between gap-3 px-5 py-2.5">
					<span class="text-muted-foreground">{RESOURCE_LABEL[r.type] ?? r.type}</span>
					<span class="font-mono text-xs">{resourceDisplay(r)}</span>
				</li>
			{:else}
				<li class="px-5 py-6 text-center text-muted-foreground">Aucune ressource externe.</li>
			{/each}
		</ul>
	</SectionCard>

	<section class="overflow-hidden rounded-xl border border-danger/40">
		<div class="flex flex-col gap-4 bg-danger/5 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
			<div>
				<h2 class="flex items-center gap-2 text-sm font-semibold text-danger"><TriangleAlert class="size-4" /> Zone dangereuse</h2>
				<p class="mt-1 text-[13px] text-muted-foreground">Supprimer le projet : sauvegarde vzdump du CT, puis suppression de ce que Forge a créé. Les volumes Docker ne sont jamais supprimés séparément.</p>
			</div>
			<Button variant="destructive" size="sm" disabled={!!data.activeJob} onclick={() => (deleteOpen = true)}><Trash2 /> Supprimer le projet</Button>
		</div>
	</section>
</div>

<AlertDialog.Root bind:open={deleteOpen}>
	<AlertDialog.Content class="sm:max-w-lg">
		<AlertDialog.Header>
			<AlertDialog.Title>Supprimer « {p.name} » ?</AlertDialog.Title>
			<AlertDialog.Description>Choisissez ce qui doit être supprimé.</AlertDialog.Description>
		</AlertDialog.Header>
		<form method="POST" action="?/delete" use:enhance class="space-y-4">
			<input type="hidden" name="mode" value={mode} />
			<div class="grid gap-2" role="radiogroup">
				<button
					type="button"
					role="radio"
					aria-checked={mode === 'full'}
					onclick={() => (mode = 'full')}
					class={cn('flex items-start gap-3 rounded-lg border p-3 text-left text-sm transition-colors', mode === 'full' ? 'border-danger/60 bg-danger/5' : 'hover:bg-accent/40')}
				>
					<Archive class="mt-0.5 size-4 shrink-0 text-danger" />
					<span>
						<span class="font-medium">Tout supprimer (après sauvegarde)</span>
						<span class="mt-0.5 block text-xs text-muted-foreground">vzdump du CT {p.ctid}, puis suppression du runner, du secret et des variables, du workflow, des proxy hosts, des DNS et du CT.</span>
					</span>
				</button>
				<button
					type="button"
					role="radio"
					aria-checked={mode === 'forget'}
					onclick={() => (mode = 'forget')}
					class={cn('flex items-start gap-3 rounded-lg border p-3 text-left text-sm transition-colors', mode === 'forget' ? 'border-ember/60 bg-ember/5' : 'hover:bg-accent/40')}
				>
					<Unlink class="mt-0.5 size-4 shrink-0 text-ember" />
					<span>
						<span class="font-medium">Garder le CT, ne supprimer que les entrées Forge</span>
						<span class="mt-0.5 block text-xs text-muted-foreground">Rien n'est touché à l'extérieur : le CT, les DNS et le proxy restent en place, Forge cesse simplement de les gérer.</span>
					</span>
				</button>
			</div>
			<div class="space-y-2">
				<Label for="confirm">Tapez <code class="rounded bg-muted px-1 py-0.5 text-foreground">{p.slug}</code> pour confirmer</Label>
				<Input id="confirm" name="confirm" bind:value={typed} autocomplete="off" spellcheck={false} class="font-mono" />
			</div>
			<AlertDialog.Footer>
				<AlertDialog.Cancel type="button">Annuler</AlertDialog.Cancel>
				<Button type="submit" variant="destructive" disabled={typed.trim() !== p.slug}><Trash2 /> {mode === 'full' ? 'Sauvegarder puis supprimer' : 'Retirer de Forge'}</Button>
			</AlertDialog.Footer>
		</form>
	</AlertDialog.Content>
</AlertDialog.Root>

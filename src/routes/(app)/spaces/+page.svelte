<script lang="ts">
	import { enhance } from '$app/forms';
	import { toast } from 'svelte-sonner';
	import Plus from '@lucide/svelte/icons/plus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import Users from '@lucide/svelte/icons/users';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import PageHeader from '$lib/components/molecules/page-header.svelte';
	import SpaceBadge from '$lib/components/atoms/space-badge.svelte';
	import StatusDot from '$lib/components/atoms/status-dot.svelte';
	import ConfirmDialog from '$lib/components/molecules/confirm-dialog.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import { SPACE_COLORS, SPACE_ICONS } from '$lib/domain/spaces';
	import { SPACE_ICON_COMPONENTS, spaceHex } from '$lib/spaces';
	import { ACCESS_LABELS } from '$lib/domain/access';
	import { statusInfo } from '$lib/status';
	import { cn } from '$lib/utils';
	import type { SubmitFunction } from '@sveltejs/kit';

	let { data } = $props();

	let creating = $state(false);
	let editing = $state<number | null>(null);
	let toDelete = $state<{ id: number; name: string } | null>(null);
	let deleteForm = $state<HTMLFormElement | null>(null);

	const done =
		(msg: string, after?: () => void): SubmitFunction =>
		() =>
		async ({ result, update }) => {
			if (result.type === 'failure') toast.error((result.data as { error?: string })?.error ?? 'Échec');
			else {
				toast.success(msg);
				after?.();
			}
			await update();
		};
</script>

<svelte:head><title>Espaces · Forge</title></svelte:head>

<PageHeader title="Espaces" description="Rangez les projets par univers (perso, entreprise, famille…). Un espace peut être confié entier à un collaborateur : il voit alors tous ses projets, même ceux ajoutés plus tard.">
	{#snippet actions()}
		<Button size="sm" onclick={() => (creating = !creating)}><Plus /> Nouvel espace</Button>
	{/snippet}
</PageHeader>

{#if creating}
	<form method="POST" action="?/create" use:enhance={done('Espace créé', () => (creating = false))} class="animate-rise mb-6 rounded-lg border bg-card p-4">
		{@render fields({ name: '', color: 'blue', icon: 'folder' }, 'Créer', () => (creating = false))}
	</form>
{/if}

{#if data.spaces.length === 0 && !creating}
	<div class="rounded-lg border border-dashed px-6 py-14 text-center">
		<FolderOpen class="mx-auto mb-3 size-8 text-muted-foreground/60" />
		<p class="font-medium">Aucun espace pour l'instant</p>
		<p class="mt-1 text-sm text-muted-foreground">Créez par exemple « Perso », « Entreprise » et « Papa », puis rangez-y vos projets.</p>
		<Button size="sm" class="mt-4" onclick={() => (creating = true)}><Plus /> Créer un espace</Button>
	</div>
{:else}
	<div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
		{#each data.spaces as s, i (s.id)}
			<section class="group relative overflow-hidden rounded-lg border bg-card">
				<div class="absolute inset-x-0 top-0 h-px" style="background: linear-gradient(90deg, transparent, {spaceHex(s.color)}, transparent)"></div>
				{#if editing === s.id}
					<form method="POST" action="?/update" use:enhance={done('Espace modifié', () => (editing = null))} class="p-4">
						<input type="hidden" name="id" value={s.id} />
						{@render fields(s, 'Enregistrer', () => (editing = null))}
					</form>
				{:else}
					<header class="flex items-center gap-3 px-4 pt-4 pb-3">
						<SpaceBadge space={s} size="md" label={false} />
						<div class="min-w-0 flex-1">
							<h2 class="truncate font-semibold">{s.name}</h2>
							<p class="text-xs text-muted-foreground">{s.projects.length} projet{s.projects.length > 1 ? 's' : ''}{s.members.length ? ` · ${s.members.length} collaborateur${s.members.length > 1 ? 's' : ''}` : ''}</p>
						</div>
						<div class="flex items-center opacity-60 transition-opacity group-hover:opacity-100">
							<form method="POST" action="?/move" use:enhance>
								<input type="hidden" name="id" value={s.id} /><input type="hidden" name="dir" value="up" />
								<Button type="submit" variant="ghost" size="icon" class="size-7" disabled={i === 0} aria-label="Monter"><ArrowUp /></Button>
							</form>
							<form method="POST" action="?/move" use:enhance>
								<input type="hidden" name="id" value={s.id} /><input type="hidden" name="dir" value="down" />
								<Button type="submit" variant="ghost" size="icon" class="size-7" disabled={i === data.spaces.length - 1} aria-label="Descendre"><ArrowDown /></Button>
							</form>
							<Button variant="ghost" size="icon" class="size-7" onclick={() => (editing = s.id)} aria-label="Modifier"><Pencil /></Button>
							<Button variant="ghost" size="icon" class="size-7 hover:text-danger" onclick={() => (toDelete = { id: s.id, name: s.name })} aria-label="Supprimer"><Trash2 /></Button>
						</div>
					</header>
					<ul class="border-t">
						{#each s.projects as p (p.slug)}
							{@const st = statusInfo(p.status)}
							<li><a href="/projects/{p.slug}" class="flex items-center gap-2.5 px-4 py-2 text-sm hover:bg-accent/50"><StatusDot tone={st.tone} /> <span class="truncate">{p.name}</span></a></li>
						{:else}
							<li class="px-4 py-3 text-xs text-muted-foreground">Aucun projet dans cet espace.</li>
						{/each}
					</ul>
					{#if data.loose.length}
						<form method="POST" action="?/assign" use:enhance={done('Projet rangé')} class="flex items-center gap-2 border-t px-4 py-2.5">
							<input type="hidden" name="id" value={s.id} />
							<select name="slug" class="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs" aria-label="Projet à ajouter">
								{#each data.loose as p (p.slug)}<option value={p.slug}>{p.name}</option>{/each}
							</select>
							<Button type="submit" size="sm" variant="outline" class="h-7 text-xs"><Plus /> Ajouter</Button>
						</form>
					{/if}
					{#if s.members.length}
						<footer class="flex flex-wrap items-center gap-1.5 border-t px-4 py-2.5 text-xs text-muted-foreground">
							<Users class="size-3.5" />
							{#each s.members as m (m.userId)}<span class="rounded border px-1.5 py-0.5"><span class="text-foreground">{m.username}</span> · {ACCESS_LABELS[m.level]}</span>{/each}
						</footer>
					{/if}
				{/if}
			</section>
		{/each}
	</div>

	{#if data.loose.length}
		<p class="mt-6 text-xs text-muted-foreground">
			{data.loose.length} projet{data.loose.length > 1 ? 's' : ''} hors espace : {data.loose.map((p) => p.name).join(', ')}. Rangez-les ici ou depuis Paramètres du projet.
		</p>
	{/if}
	<p class="mt-2 text-xs text-muted-foreground">Pour confier un espace à un collaborateur : page <a href="/users" class="text-foreground underline underline-offset-4">Utilisateurs</a>.</p>
{/if}

<form method="POST" action="?/delete" bind:this={deleteForm} use:enhance={done('Espace supprimé')} class="hidden">
	<input type="hidden" name="id" value={toDelete?.id ?? ''} />
</form>
<ConfirmDialog
	open={!!toDelete}
	title="Supprimer l'espace « {toDelete?.name} » ?"
	description="Les projets ne sont pas touchés : ils passent simplement « hors espace ». Les collaborateurs qui avaient accès à l'espace perdent cet accès."
	confirmLabel="Supprimer"
	destructive
	onConfirm={() => {
		deleteForm?.requestSubmit();
		toDelete = null;
	}}
/>

{#snippet fields(s: { name: string; color: string; icon: string }, submit: string, cancel: () => void)}
	<div class="space-y-4">
		<label class="block space-y-1.5">
			<span class="text-xs font-medium text-muted-foreground">Nom</span>
			<!-- svelte-ignore a11y_autofocus -->
			<input name="name" value={s.name} required maxlength="32" autofocus placeholder="Perso, Entreprise, Papa…" class="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-ember/60 focus:ring-2 focus:ring-ember/20" />
		</label>
		<fieldset class="space-y-1.5">
			<legend class="text-xs font-medium text-muted-foreground">Couleur</legend>
			<div class="flex flex-wrap gap-2">
				{#each SPACE_COLORS as c (c)}
					<label class="cursor-pointer">
						<input type="radio" name="color" value={c} checked={s.color === c} class="peer sr-only" />
						<span class="block size-6 rounded-full ring-offset-2 ring-offset-card transition peer-checked:ring-2 peer-focus-visible:ring-2" style="background: {spaceHex(c)}; --tw-ring-color: {spaceHex(c)}" title={c}></span>
					</label>
				{/each}
			</div>
		</fieldset>
		<fieldset class="space-y-1.5">
			<legend class="text-xs font-medium text-muted-foreground">Icône</legend>
			<div class="flex flex-wrap gap-1.5">
				{#each SPACE_ICONS as ic (ic)}
					{@const Icon = SPACE_ICON_COMPONENTS[ic]}
					<label class="cursor-pointer">
						<input type="radio" name="icon" value={ic} checked={s.icon === ic} class="peer sr-only" />
						<span class={cn('grid size-8 place-items-center rounded-md border text-muted-foreground transition hover:text-foreground', 'peer-checked:border-ember/60 peer-checked:bg-ember/10 peer-checked:text-ember peer-focus-visible:ring-2 peer-focus-visible:ring-ember/30')}><Icon class="size-4" /></span>
					</label>
				{/each}
			</div>
		</fieldset>
		<div class="flex justify-end gap-2">
			<Button type="button" variant="ghost" size="sm" onclick={cancel}>Annuler</Button>
			<Button type="submit" size="sm">{submit}</Button>
		</div>
	</div>
{/snippet}

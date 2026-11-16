<script lang="ts">
	import { page } from '$app/state';
	import { invalidate } from '$app/navigation';
	import { coalesce, onJobChange } from '$lib/live.svelte';
	import Plus from '@lucide/svelte/icons/plus';
	import Boxes from '@lucide/svelte/icons/boxes';
	import Search from '@lucide/svelte/icons/search';
	import Moon from '@lucide/svelte/icons/moon';
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import LayoutGrid from '@lucide/svelte/icons/layout-grid';
	import List from '@lucide/svelte/icons/list';
	import Hash from '@lucide/svelte/icons/hash';
	import Folder from '@lucide/svelte/icons/folder';
	import FolderCog from '@lucide/svelte/icons/folder-cog';
	import X from '@lucide/svelte/icons/x';
	import StatusDot from '$lib/components/atoms/status-dot.svelte';
	import SpaceBadge from '$lib/components/atoms/space-badge.svelte';
	import StatusBadge from '$lib/components/molecules/status-badge.svelte';
	import RelativeTime from '$lib/components/molecules/relative-time.svelte';
	import EmptyState from '$lib/components/molecules/empty-state.svelte';
	import GithubIcon from '$lib/components/atoms/github-icon.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import { statusInfo } from '$lib/status';
	import { spaceHex } from '$lib/spaces';
	import { cn } from '$lib/utils';

	let { data } = $props();
	onJobChange(coalesce(() => invalidate('forge:projects')));

	type Space = { id: number; name: string; color: string; icon: string };
	const spaces = $derived(((page.data as { spaces?: Space[] }).spaces ?? []) as Space[]);
	const isAdmin = $derived(page.data.user?.role === 'admin');

	type Filter = 'all' | 'production' | 'development' | 'problem' | 'sleeping';
	let q = $state('');
	let filter = $state<Filter>('all');
	/** 'all', un id d'espace, ou 'none' (hors espace). */
	let spaceSel = $state<'all' | 'none' | number>('all');
	let tagSel = $state<string[]>([]);
	let view = $state<'grid' | 'list'>('grid');
	$effect(() => {
		try {
			const v = localStorage.getItem('forge.projects.view');
			if (v === 'list' || v === 'grid') view = v;
		} catch {
			/* stockage indisponible */
		}
	});
	function setView(v: 'grid' | 'list') {
		view = v;
		try {
			localStorage.setItem('forge.projects.view', v);
		} catch {
			/* stockage indisponible */
		}
	}

	type P = (typeof data.projects)[number];
	const problem = (p: P) => p.status === 'error' || p.lastJob?.status === 'failed';
	const FILTERS: { value: Filter; label: string; test: (p: P) => boolean }[] = [
		{ value: 'all', label: 'Tous', test: () => true },
		{ value: 'production', label: 'Production', test: (p) => p.environment !== 'development' },
		{ value: 'development', label: 'Dev', test: (p) => p.environment === 'development' },
		{ value: 'problem', label: 'À problème', test: problem },
		{ value: 'sleeping', label: 'En veille', test: (p) => !!p.sleepingSince }
	];
	const counts = $derived(Object.fromEntries(FILTERS.map((f) => [f.value, data.projects.filter(f.test).length])) as Record<Filter, number>);
	const spaceOf = (p: P) => spaces.find((s) => s.id === p.spaceId) ?? null;
	const allTags = $derived([...new Set(data.projects.flatMap((p) => p.tags))].sort((a, b) => a.localeCompare(b, 'fr')));
	const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
	const shown = $derived(
		data.projects.filter((p) => {
			if (!FILTERS.find((f) => f.value === filter)!.test(p)) return false;
			if (spaceSel === 'none' && spaceOf(p)) return false;
			if (typeof spaceSel === 'number' && p.spaceId !== spaceSel) return false;
			if (tagSel.length && !tagSel.every((t) => p.tags.includes(t))) return false;
			if (!q.trim()) return true;
			const hay = norm([p.name, p.slug, `${p.repoOwner}/${p.repoName}`, p.ip ?? '', p.ctid ? `ct ${p.ctid}` : '', spaceOf(p)?.name ?? '', ...p.tags.map((t) => `#${t}`), ...p.domains.map((d) => d.fqdn)].join(' '));
			return norm(q).trim().split(/\s+/).every((w) => hay.includes(w.replace(/^#/, '')));
		})
	);
	// Sans filtre d'espace : un bloc par espace, puis les projets hors espace.
	const groups = $derived.by(() => {
		if (spaceSel !== 'all' || spaces.length === 0) return [{ key: 'flat', space: null as Space | null, items: shown }];
		const out = spaces.map((s) => ({ key: `s${s.id}`, space: s as Space | null, items: shown.filter((p) => p.spaceId === s.id) })).filter((g) => g.items.length);
		const loose = shown.filter((p) => !spaceOf(p));
		if (loose.length) out.push({ key: 'loose', space: null, items: loose });
		return out;
	});
	const looseCount = $derived(data.projects.filter((p) => !spaceOf(p)).length);
	const canCreate = $derived(!!page.data.user?.canCreate);
	const anyFilter = $derived(!!q || filter !== 'all' || spaceSel !== 'all' || tagSel.length > 0);
	function reset() {
		q = '';
		filter = 'all';
		spaceSel = 'all';
		tagSel = [];
	}
	function toggleTag(t: string) {
		tagSel = tagSel.includes(t) ? tagSel.filter((x) => x !== t) : [...tagSel, t];
	}
	const chip = (on: boolean) =>
		cn('inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors', on ? 'border-ember/45 bg-ember/10 text-foreground' : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground');
</script>

<svelte:head><title>Projets · Forge</title></svelte:head>

<header class="animate-rise mb-6 flex flex-wrap items-end justify-between gap-4">
	<div>
		<p class="label-caps mb-2 text-muted-foreground">{data.projects.length} projet{data.projects.length > 1 ? 's' : ''}{spaces.length ? ` · ${spaces.length} espace${spaces.length > 1 ? 's' : ''}` : ''}</p>
		<h1 class="text-[26px] leading-tight font-semibold tracking-[-0.025em]">Projets</h1>
		<p class="mt-1 text-sm text-muted-foreground">Chaque projet est un dépôt GitHub déployé dans son propre conteneur.</p>
	</div>
	<div class="flex items-center gap-2">
		{#if isAdmin}<Button href="/spaces" size="sm" variant="outline"><FolderCog /> Espaces</Button>{/if}
		{#if canCreate}<Button href="/projects/new" size="sm"><Plus /> Nouveau projet</Button>{/if}
	</div>
</header>

{#if data.projects.length === 0}
	<EmptyState icon={Boxes} title="Aucun projet" description="Créez votre premier projet à partir d'un dépôt GitHub : Forge prépare le conteneur, le domaine et le déploiement.">
		{#if canCreate}<Button href="/projects/new" size="sm"><Plus /> Créer un projet</Button>{/if}
	</EmptyState>
{:else}
	<div class="mb-5 space-y-2.5">
		<div class="flex flex-col gap-3 sm:flex-row sm:items-center">
			<div class="relative flex-1 sm:max-w-xs">
				<Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
				<input bind:value={q} placeholder="Nom, domaine, #tag…" aria-label="Rechercher un projet" class="h-8 w-full rounded-md border bg-card pr-8 pl-9 text-[13px] outline-none transition focus:border-ember/60 focus:ring-3 focus:ring-ember/15 dark:bg-black/25" />
				{#if q}<button class="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground" onclick={() => (q = '')} aria-label="Effacer"><X class="size-3.5" /></button>{/if}
			</div>
			<div class="flex flex-1 flex-wrap items-center gap-1.5">
				{#each FILTERS as f (f.value)}
					{#if f.value === 'all' || counts[f.value]}
						<button class={cn(chip(filter === f.value), f.value === 'problem' && filter !== f.value && 'text-danger')} onclick={() => (filter = f.value)}>
							{f.label} <span class="font-mono text-[10.5px] tabular-nums opacity-60">{counts[f.value]}</span>
						</button>
					{/if}
				{/each}
			</div>
			<div class="flex rounded-md border bg-card p-0.5">
				<button class={cn('rounded-sm p-1', view === 'grid' ? 'bg-accent text-foreground' : 'text-muted-foreground')} onclick={() => setView('grid')} aria-label="Vue en grille"><LayoutGrid class="size-4" /></button>
				<button class={cn('rounded-sm p-1', view === 'list' ? 'bg-accent text-foreground' : 'text-muted-foreground')} onclick={() => setView('list')} aria-label="Vue en liste"><List class="size-4" /></button>
			</div>
		</div>

		{#if spaces.length || allTags.length}
			<div class="flex flex-wrap items-center gap-1.5 border-t border-dashed pt-2.5">
				{#if spaces.length}
					<button class={chip(spaceSel === 'all')} onclick={() => (spaceSel = 'all')}>Tous les espaces</button>
					{#each spaces as s (s.id)}
						{@const n = data.projects.filter((p) => p.spaceId === s.id).length}
						{#if n}
							<button class={chip(spaceSel === s.id)} onclick={() => (spaceSel = spaceSel === s.id ? 'all' : s.id)}>
								<SpaceBadge space={s} size="xs" /> <span class="font-mono text-[10.5px] tabular-nums opacity-60">{n}</span>
							</button>
						{/if}
					{/each}
					{#if looseCount}
						<button class={chip(spaceSel === 'none')} onclick={() => (spaceSel = spaceSel === 'none' ? 'all' : 'none')}><Folder class="size-3.5" /> Hors espace <span class="font-mono text-[10.5px] tabular-nums opacity-60">{looseCount}</span></button>
					{/if}
				{/if}
				{#if spaces.length && allTags.length}<span class="mx-1 h-4 w-px bg-border"></span>{/if}
				{#each allTags as t (t)}
					<button
						class={cn('inline-flex h-6 items-center gap-0.5 rounded-full border px-2 font-mono text-[11px] transition-colors', tagSel.includes(t) ? 'border-ember/50 bg-ember/10 text-foreground' : 'text-muted-foreground hover:border-foreground/25 hover:text-foreground')}
						onclick={() => toggleTag(t)}
						aria-pressed={tagSel.includes(t)}
					><Hash class="size-3 opacity-60" />{t}</button>
				{/each}
			</div>
		{/if}
	</div>

	{#if shown.length === 0}
		<div class="rounded-lg border border-dashed px-5 py-12 text-center text-sm text-muted-foreground">
			Aucun projet ne correspond. <button class="text-foreground underline underline-offset-4" onclick={reset}>Tout afficher</button>
		</div>
	{:else}
		<div class="space-y-8">
			{#each groups as g (g.key)}
				<section class="space-y-3">
					{#if g.key !== 'flat'}
						<div class="flex items-center gap-3">
							{#if g.space}
								<SpaceBadge space={g.space} size="sm" class="text-[13px] font-semibold" />
							{:else}
								<span class="inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted-foreground"><Folder class="size-4" /> Hors espace</span>
							{/if}
							<span class="font-mono text-[11px] text-muted-foreground tabular-nums">{g.items.length}</span>
							<span class="h-px flex-1" style="background: linear-gradient(90deg, {g.space ? spaceHex(g.space.color) : 'var(--border)'} 0%, var(--border) 30%, transparent)"></span>
						</div>
					{/if}
					{#if view === 'grid'}
						<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
							{#each g.items as p (p.id)}{@render card(p, g.key === 'flat')}{/each}
						</div>
					{:else}
						<ul class="divide-y overflow-hidden rounded-lg border bg-card">
							{#each g.items as p (p.id)}{@render row(p, g.key === 'flat')}{/each}
						</ul>
					{/if}
				</section>
			{/each}
		</div>
		{#if anyFilter}<p class="mt-6 text-center text-xs text-muted-foreground">{shown.length} sur {data.projects.length} · <button class="underline underline-offset-4 hover:text-foreground" onclick={reset}>effacer les filtres</button></p>{/if}
	{/if}
{/if}

{#snippet tags(p: P)}
	{#each p.tags as t (t)}
		<button
			class={cn('relative z-10 inline-flex h-5 items-center rounded-full border px-1.5 font-mono text-[10.5px] transition-colors', tagSel.includes(t) ? 'border-ember/50 text-foreground' : 'text-muted-foreground hover:text-foreground')}
			onclick={() => toggleTag(t)}>#{t}</button
		>
	{/each}
{/snippet}

{#snippet card(p: P, showSpace: boolean)}
	{@const st = statusInfo(p.status)}
	{@const d0 = p.domains[0]}
	{@const sp = spaceOf(p)}
	<article
		class="group relative flex flex-col overflow-hidden rounded-lg border bg-card transition-all before:absolute before:inset-x-0 before:top-0 before:h-px before:opacity-0 before:transition-opacity hover:-translate-y-px hover:border-foreground/20 hover:shadow-[0_8px_30px_-12px_rgb(0_0_0/0.5)] hover:before:opacity-100"
		style="--sp: {sp ? spaceHex(sp.color) : 'var(--ember)'}"
	>
		<span class="pointer-events-none absolute inset-x-0 top-0 h-px opacity-0 transition-opacity group-hover:opacity-100" style="background: linear-gradient(90deg, transparent, var(--sp), transparent)"></span>
		<div class="flex items-start justify-between gap-2 p-4 pb-3">
			<div class="min-w-0">
				<a href="/projects/{p.slug}" class="flex items-center gap-2 font-medium after:absolute after:inset-0">
					{#if p.sleepingSince}<Moon class="size-3.5 text-info" />{:else}<StatusDot tone={st.tone} pulse={st.pulse} />{/if}
					<span class="truncate">{p.name}</span>
				</a>
				<p class="mt-1 flex items-center gap-1.5 truncate text-xs text-muted-foreground"><GithubIcon class="size-3 shrink-0" /> {p.repoOwner}/{p.repoName} <span class="opacity-60">@{p.branch}</span></p>
			</div>
			<div class="flex shrink-0 items-center gap-1.5">
				{#if showSpace && sp}<SpaceBadge space={sp} size="xs" label={false} />{/if}
				<span class={cn('rounded-sm px-1.5 py-px font-mono text-[10px] font-medium tracking-wider uppercase ring-1 ring-inset', p.environment === 'development' ? 'bg-info/10 text-info ring-info/25' : 'bg-foreground/[0.04] text-muted-foreground ring-border')}>
					{p.environment === 'development' ? 'dev' : 'prod'}
				</span>
			</div>
		</div>
		<div class="flex flex-wrap items-center gap-1.5 px-4 pb-3">
			{#if d0}
				<a href="https://{d0.fqdn}" target="_blank" rel="noreferrer" class="relative z-10 inline-flex max-w-full items-center gap-1 truncate font-mono text-xs text-muted-foreground hover:text-ember">
					{d0.fqdn}<ArrowUpRight class="size-3 shrink-0" />
				</a>
				{#if p.domains.length > 1}<span class="text-xs text-muted-foreground">+{p.domains.length - 1}</span>{/if}
			{:else}
				<span class="text-xs text-muted-foreground/70">Aucun domaine</span>
			{/if}
		</div>
		{#if p.tags.length}<div class="flex flex-wrap gap-1 px-4 pb-3">{@render tags(p)}</div>{/if}
		<div class="mt-auto flex items-center justify-between gap-2 border-t bg-foreground/[0.015] px-4 py-2 text-xs text-muted-foreground">
			{#if p.lastJob}
				<span class="truncate">{p.lastJob.label} · <RelativeTime value={p.lastJob.createdAt} /></span>
				<StatusBadge status={p.lastJob.status} />
			{:else}
				<span>Jamais déployé</span>
			{/if}
		</div>
	</article>
{/snippet}

{#snippet row(p: P, showSpace: boolean)}
	{@const st = statusInfo(p.status)}
	{@const sp = spaceOf(p)}
	<li class="relative flex items-center gap-4 px-4 py-2.5 transition-colors hover:bg-foreground/[0.03]">
		{#if p.sleepingSince}<Moon class="size-3.5 text-info" />{:else}<StatusDot tone={st.tone} pulse={st.pulse} />{/if}
		<a href="/projects/{p.slug}" class="min-w-0 flex-1 truncate after:absolute after:inset-0">
			<span class="text-[13px] font-medium">{p.name}</span>
			<span class="ml-2 font-mono text-[11px] text-muted-foreground">{p.environment === 'development' ? 'dev' : 'prod'} · {p.domains[0]?.fqdn ?? 'sans domaine'}</span>
		</a>
		<span class="hidden items-center gap-1 lg:flex">{@render tags(p)}</span>
		{#if showSpace && sp}<SpaceBadge space={sp} size="xs" class="hidden text-xs text-muted-foreground md:inline-flex" />{/if}
		<span class="hidden w-14 font-mono text-xs text-muted-foreground md:inline">{p.ctid ? `CT ${p.ctid}` : ''}</span>
		{#if p.lastJob}<span class="hidden text-xs text-muted-foreground sm:inline"><RelativeTime value={p.lastJob.createdAt} /></span><StatusBadge status={p.lastJob.status} />{/if}
	</li>
{/snippet}

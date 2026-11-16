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
	import X from '@lucide/svelte/icons/x';
	import StatusDot from '$lib/components/atoms/status-dot.svelte';
	import StatusBadge from '$lib/components/molecules/status-badge.svelte';
	import RelativeTime from '$lib/components/molecules/relative-time.svelte';
	import EmptyState from '$lib/components/molecules/empty-state.svelte';
	import GithubIcon from '$lib/components/atoms/github-icon.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import { statusInfo } from '$lib/status';
	import { cn } from '$lib/utils';

	let { data } = $props();
	onJobChange(coalesce(() => invalidate('forge:projects')));

	type Filter = 'all' | 'production' | 'development' | 'problem' | 'sleeping';
	let q = $state('');
	let filter = $state<Filter>('all');
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
		{ value: 'development', label: 'Développement', test: (p) => p.environment === 'development' },
		{ value: 'problem', label: 'À problème', test: problem },
		{ value: 'sleeping', label: 'En veille', test: (p) => !!p.sleepingSince }
	];
	const counts = $derived(Object.fromEntries(FILTERS.map((f) => [f.value, data.projects.filter(f.test).length])) as Record<Filter, number>);
	const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
	const shown = $derived(
		data.projects.filter((p) => {
			if (!FILTERS.find((f) => f.value === filter)!.test(p)) return false;
			if (!q.trim()) return true;
			const hay = norm([p.name, p.slug, `${p.repoOwner}/${p.repoName}`, p.ip ?? '', p.ctid ? `ct ${p.ctid}` : '', ...p.domains.map((d) => d.fqdn)].join(' '));
			return norm(q).trim().split(/\s+/).every((w) => hay.includes(w));
		})
	);
	const canCreate = $derived(!!page.data.user?.canCreate);
</script>

<svelte:head><title>Projets · Forge</title></svelte:head>

<header class="mb-6 flex flex-wrap items-end justify-between gap-4">
	<div>
		<h1 class="text-2xl font-semibold tracking-tight">Projets</h1>
		<p class="mt-1 text-sm text-muted-foreground">Chaque projet est un dépôt GitHub déployé dans son propre conteneur.</p>
	</div>
	{#if canCreate}<Button href="/projects/new" size="sm"><Plus /> Nouveau projet</Button>{/if}
</header>

{#if data.projects.length === 0}
	<EmptyState icon={Boxes} title="Aucun projet" description="Créez votre premier projet à partir d'un dépôt GitHub : Forge prépare le conteneur, le domaine et le déploiement.">
		{#if canCreate}<Button href="/projects/new" size="sm"><Plus /> Créer un projet</Button>{/if}
	</EmptyState>
{:else}
	<div class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
		<div class="relative flex-1 sm:max-w-xs">
			<Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
			<input bind:value={q} placeholder="Rechercher…" aria-label="Rechercher un projet" class="h-9 w-full rounded-lg border bg-card pr-8 pl-9 text-sm outline-none transition focus:border-ember/50 focus:ring-2 focus:ring-ember/20" />
			{#if q}<button class="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground" onclick={() => (q = '')} aria-label="Effacer"><X class="size-3.5" /></button>{/if}
		</div>
		<div class="flex flex-1 flex-wrap items-center gap-1.5">
			{#each FILTERS as f (f.value)}
				{#if f.value === 'all' || counts[f.value]}
					<button
						class={cn(
							'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors',
							filter === f.value ? 'border-foreground/20 bg-foreground text-background' : 'bg-card text-muted-foreground hover:text-foreground',
							f.value === 'problem' && filter !== f.value && 'text-danger'
						)}
						onclick={() => (filter = f.value)}
					>
						{f.label} <span class="tabular-nums opacity-60">{counts[f.value]}</span>
					</button>
				{/if}
			{/each}
		</div>
		<div class="flex rounded-lg border bg-card p-0.5">
			<button class={cn('rounded-md p-1.5', view === 'grid' ? 'bg-accent text-foreground' : 'text-muted-foreground')} onclick={() => setView('grid')} aria-label="Vue en grille"><LayoutGrid class="size-4" /></button>
			<button class={cn('rounded-md p-1.5', view === 'list' ? 'bg-accent text-foreground' : 'text-muted-foreground')} onclick={() => setView('list')} aria-label="Vue en liste"><List class="size-4" /></button>
		</div>
	</div>

	{#if shown.length === 0}
		<div class="rounded-xl border border-dashed px-5 py-12 text-center text-sm text-muted-foreground">
			Aucun projet ne correspond. <button class="text-foreground underline underline-offset-4" onclick={() => ((q = ''), (filter = 'all'))}>Tout afficher</button>
		</div>
	{:else if view === 'grid'}
		<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
			{#each shown as p (p.id)}
				{@const st = statusInfo(p.status)}
				{@const d0 = p.domains[0]}
				<article class="group relative flex flex-col rounded-xl border bg-card transition-all hover:border-foreground/20 hover:shadow-md">
					<div class="flex items-start justify-between gap-2 p-4 pb-3">
						<div class="min-w-0">
							<a href="/projects/{p.slug}" class="flex items-center gap-2 font-medium after:absolute after:inset-0">
								{#if p.sleepingSince}<Moon class="size-3.5 text-info" />{:else}<StatusDot tone={st.tone} pulse={st.pulse} />{/if}
								<span class="truncate">{p.name}</span>
							</a>
							<p class="mt-1 flex items-center gap-1.5 truncate text-xs text-muted-foreground"><GithubIcon class="size-3 shrink-0" /> {p.repoOwner}/{p.repoName} <span class="opacity-60">@{p.branch}</span></p>
						</div>
						<span class={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase', p.environment === 'development' ? 'bg-info/12 text-info' : 'bg-muted text-muted-foreground')}>
							{p.environment === 'development' ? 'dev' : 'prod'}
						</span>
					</div>
					<div class="px-4 pb-3">
						{#if d0}
							<a href="https://{d0.fqdn}" target="_blank" rel="noreferrer" class="relative z-10 inline-flex max-w-full items-center gap-1 truncate font-mono text-xs text-muted-foreground hover:text-ember">
								{d0.fqdn}<ArrowUpRight class="size-3 shrink-0" />
							</a>
							{#if p.domains.length > 1}<span class="ml-1 text-xs text-muted-foreground">+{p.domains.length - 1}</span>{/if}
						{:else}
							<span class="text-xs text-muted-foreground/70">Aucun domaine</span>
						{/if}
					</div>
					<div class="mt-auto flex items-center justify-between gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground">
						{#if p.lastJob}
							<span class="truncate">{p.lastJob.label} · <RelativeTime value={p.lastJob.createdAt} /></span>
							<StatusBadge status={p.lastJob.status} />
						{:else}
							<span>Jamais déployé</span>
						{/if}
					</div>
				</article>
			{/each}
		</div>
	{:else}
		<ul class="divide-y overflow-hidden rounded-xl border bg-card">
			{#each shown as p (p.id)}
				{@const st = statusInfo(p.status)}
				<li class="relative flex items-center gap-4 px-4 py-3 transition-colors hover:bg-accent/40">
					{#if p.sleepingSince}<Moon class="size-3.5 text-info" />{:else}<StatusDot tone={st.tone} pulse={st.pulse} />{/if}
					<a href="/projects/{p.slug}" class="min-w-0 flex-1 after:absolute after:inset-0">
						<span class="font-medium">{p.name}</span>
						<span class="ml-2 text-xs text-muted-foreground">{p.environment === 'development' ? 'dev' : 'prod'} · {p.domains[0]?.fqdn ?? 'sans domaine'}</span>
					</a>
					<span class="hidden font-mono text-xs text-muted-foreground md:inline">{p.ctid ? `CT ${p.ctid}` : ''}</span>
					{#if p.lastJob}<span class="hidden text-xs text-muted-foreground sm:inline"><RelativeTime value={p.lastJob.createdAt} /></span><StatusBadge status={p.lastJob.status} />{/if}
				</li>
			{/each}
		</ul>
	{/if}
{/if}

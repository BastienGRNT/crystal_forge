<script lang="ts">
	import { page } from '$app/state';
	import { invalidate } from '$app/navigation';
	import { coalesce, onJobChange } from '$lib/live.svelte';
	import Plus from '@lucide/svelte/icons/plus';
	import Boxes from '@lucide/svelte/icons/boxes';
	import Globe from '@lucide/svelte/icons/globe';
	import Container from '@lucide/svelte/icons/container';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import PageHeader from '$lib/components/molecules/page-header.svelte';
	import StatusBadge from '$lib/components/molecules/status-badge.svelte';
	import RelativeTime from '$lib/components/molecules/relative-time.svelte';
	import EmptyState from '$lib/components/molecules/empty-state.svelte';
	import GithubIcon from '$lib/components/atoms/github-icon.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import { Badge } from '$lib/components/atoms/ui/badge';
	import { Input } from '$lib/components/atoms/ui/input';
	import Search from '@lucide/svelte/icons/search';
	import { statusInfo } from '$lib/status';

	let { data } = $props();
	onJobChange(coalesce(() => invalidate('forge:projects')));

	let q = $state('');
	let env = $state<'all' | 'development' | 'production'>('all');
	let status = $state('all');
	const statuses = $derived([...new Set(data.projects.map((p) => p.status))].sort());
	const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
	const shown = $derived(
		data.projects.filter((p) => {
			if (env !== 'all' && p.environment !== env) return false;
			if (status !== 'all' && p.status !== status) return false;
			if (!q.trim()) return true;
			const hay = norm([p.name, p.slug, `${p.repoOwner}/${p.repoName}`, p.ip ?? '', p.ctid ? `ct ${p.ctid}` : '', ...p.domains.map((d) => d.fqdn)].join(' '));
			return norm(q).trim().split(/\s+/).every((w) => hay.includes(w));
		})
	);
	const selectClass = 'h-9 rounded-md border bg-background px-2 text-sm';
</script>

<svelte:head><title>Projets · Forge</title></svelte:head>

<PageHeader title="Projets" description="1 projet = 1 conteneur LXC = 1 runner GitHub self-hosted.">
	{#snippet actions()}{#if page.data.user?.canCreate}<Button href="/projects/new" size="sm"><Plus /> Nouveau projet</Button>{/if}{/snippet}
</PageHeader>

{#if data.projects.length === 0}
	<EmptyState icon={Boxes} title="Aucun projet" description="Créez votre premier projet à partir d'un dépôt GitHub.">
		{#if page.data.user?.canCreate}<Button href="/projects/new" size="sm"><Plus /> Nouveau projet</Button>{/if}
	</EmptyState>
{:else}
	<div class="mb-4 flex flex-wrap items-center gap-2">
		<div class="relative min-w-56 flex-1">
			<Search class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
			<Input bind:value={q} placeholder="Nom, dépôt, domaine, IP…" class="pl-8" aria-label="Rechercher un projet" />
		</div>
		<select bind:value={env} class={selectClass} aria-label="Environnement">
			<option value="all">Tous les environnements</option>
			<option value="production">Production</option>
			<option value="development">Développement</option>
		</select>
		<select bind:value={status} class={selectClass} aria-label="Statut">
			<option value="all">Tous les statuts</option>
			{#each statuses as s (s)}<option value={s}>{statusInfo(s).label}</option>{/each}
		</select>
		<span class="text-xs text-muted-foreground">{shown.length} / {data.projects.length} · <kbd class="rounded border px-1 font-mono">Ctrl K</kbd> pour sauter à un projet</span>
	</div>
	{#if shown.length === 0}
		<p class="rounded-xl border bg-card px-5 py-8 text-center text-sm text-muted-foreground">Aucun projet ne correspond.</p>
	{:else}
	<ul class="divide-y overflow-hidden rounded-xl border bg-card">
		{#each shown as p (p.id)}
			<li>
				<a href="/projects/{p.slug}" class="group flex flex-col gap-3 px-5 py-4 transition-colors hover:bg-accent/40 md:flex-row md:items-center">
					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-2">
							<span class="font-medium">{p.name}</span>
							<StatusBadge status={p.status} />
							<Badge variant={p.environment === 'development' ? 'outline' : 'secondary'}>{p.environment === 'development' ? 'DEV' : 'PROD'}</Badge>
							<Badge variant="secondary" class="font-mono">{p.deployMode === 'compose' ? 'compose' : 'dockerfile'}</Badge>
						</div>
						<div class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
							<span class="inline-flex items-center gap-1.5 font-mono"><GithubIcon class="size-3.5" /> {p.repoOwner}/{p.repoName}</span>
							{#if p.ctid}<span class="inline-flex items-center gap-1.5 font-mono"><Container class="size-3.5" /> CT {p.ctid} · {p.ip}</span>{/if}
							{#each p.domains as d (d.fqdn)}<span class="inline-flex items-center gap-1.5 font-mono"><Globe class="size-3.5" /> {d.fqdn}</span>{/each}
						</div>
					</div>
					<div class="flex items-center gap-3 text-xs text-muted-foreground">
						{#if p.lastJob}
							<span>{p.lastJob.label} · <RelativeTime value={p.lastJob.createdAt} /></span>
							<StatusBadge status={p.lastJob.status} />
						{/if}
						<ChevronRight class="size-4 transition-transform group-hover:translate-x-0.5" />
					</div>
				</a>
			</li>
		{/each}
	</ul>
	{/if}
{/if}

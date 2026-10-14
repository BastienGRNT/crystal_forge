<script lang="ts">
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

	let { data } = $props();
</script>

<svelte:head><title>Projets · Forge</title></svelte:head>

<PageHeader title="Projets" description="1 projet = 1 conteneur LXC = 1 runner GitHub self-hosted.">
	{#snippet actions()}<Button href="/projects/new" size="sm"><Plus /> Nouveau projet</Button>{/snippet}
</PageHeader>

{#if data.projects.length === 0}
	<EmptyState icon={Boxes} title="Aucun projet" description="Créez votre premier projet à partir d'un dépôt GitHub.">
		<Button href="/projects/new" size="sm"><Plus /> Nouveau projet</Button>
	</EmptyState>
{:else}
	<ul class="divide-y overflow-hidden rounded-xl border bg-card">
		{#each data.projects as p (p.id)}
			<li>
				<a href="/projects/{p.slug}" class="group flex flex-col gap-3 px-5 py-4 transition-colors hover:bg-accent/40 md:flex-row md:items-center">
					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-2">
							<span class="font-medium">{p.name}</span>
							<StatusBadge status={p.status} />
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

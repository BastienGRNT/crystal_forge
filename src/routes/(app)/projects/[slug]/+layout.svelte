<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import Rocket from '@lucide/svelte/icons/rocket';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Globe from '@lucide/svelte/icons/globe';
	import Container from '@lucide/svelte/icons/container';
	import Settings from '@lucide/svelte/icons/settings';
	import Database from '@lucide/svelte/icons/database';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import PageHeader from '$lib/components/molecules/page-header.svelte';
	import StatusBadge from '$lib/components/molecules/status-badge.svelte';
	import GithubIcon from '$lib/components/atoms/github-icon.svelte';
	import Spinner from '$lib/components/atoms/spinner.svelte';
	import { cn } from '$lib/utils';

	let { data, children } = $props();
	const p = $derived(data.project);
	const base = $derived(`/projects/${p.slug}`);
	const tabs = $derived([
		{ href: `${base}/deployments`, label: 'Déploiements', icon: Rocket },
		{ href: `${base}/variables`, label: 'Variables', icon: KeyRound },
		{ href: `${base}/domains`, label: 'Domaines', icon: Globe },
		{ href: `${base}/database`, label: 'Base de données', icon: Database },
		{ href: `${base}/container`, label: 'Conteneur', icon: Container },
		{ href: `${base}/settings`, label: 'Paramètres', icon: Settings }
	]);

	onMount(() => {
		const t = setInterval(() => {
			if (data.activeJob) void invalidate('forge:project');
		}, 3000);
		return () => clearInterval(t);
	});
</script>

<PageHeader title={p.name}>
	{#snippet eyebrow()}
		<a href="/projects" class="hover:text-foreground">Projets</a>
		<span>/</span>
		<span class="font-mono">{p.slug}</span>
	{/snippet}
	<div class="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1 text-sm text-muted-foreground">
		<StatusBadge status={p.status} />
		<a href="https://github.com/{p.repoOwner}/{p.repoName}" target="_blank" rel="noreferrer" class="inline-flex items-center gap-1.5 font-mono text-xs hover:text-foreground">
			<GithubIcon class="size-3.5" />
			{p.repoOwner}/{p.repoName}@{p.branch}
		</a>
		{#if p.ctid}<span class="inline-flex items-center gap-1.5 font-mono text-xs"><Container class="size-3.5" /> CT {p.ctid} · {p.ip}</span>{/if}
		{#each data.domains as d (d.id)}
			<a href="https://{d.fqdn}" target="_blank" rel="noreferrer" class="inline-flex items-center gap-1 font-mono text-xs hover:text-foreground">
				{d.fqdn}<ExternalLink class="size-3" />
			</a>
		{/each}
	</div>
</PageHeader>

{#if data.activeJob}
	<a
		href="/jobs/{data.activeJob.id}"
		class="mb-6 flex items-center gap-3 rounded-xl border border-info/30 bg-info/5 px-4 py-3 text-sm transition-colors hover:bg-info/10"
	>
		<Spinner class="text-info" />
		<span class="min-w-0 flex-1 truncate">
			<span class="font-medium">{data.activeJob.label}</span>
			<span class="text-muted-foreground"> — {data.activeJob.currentStep ?? 'en file'} </span>
		</span>
		<StatusBadge status={data.activeJob.status} />
		<ArrowRight class="size-4 text-muted-foreground" />
	</a>
{/if}

<nav class="scrollbar-thin mb-6 flex gap-1 overflow-x-auto border-b" aria-label="Sections du projet">
	{#each tabs as t (t.href)}
		{@const active = page.url.pathname.startsWith(t.href)}
		<a
			href={t.href}
			class={cn(
				'-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3 pb-2.5 text-sm font-medium transition-colors',
				active ? 'border-ember text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
			)}
			aria-current={active ? 'page' : undefined}
		>
			<t.icon class="size-4" />
			{t.label}
		</a>
	{/each}
</nav>

{@render children()}

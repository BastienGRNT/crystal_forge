<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { coalesce, onJobChange } from '$lib/live.svelte';
	import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
	import Rocket from '@lucide/svelte/icons/rocket';
	import ScrollText from '@lucide/svelte/icons/scroll-text';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Globe from '@lucide/svelte/icons/globe';
	import Gauge from '@lucide/svelte/icons/gauge';
	import Settings from '@lucide/svelte/icons/settings';
	import Database from '@lucide/svelte/icons/database';
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Plus from '@lucide/svelte/icons/plus';
	import GitFork from '@lucide/svelte/icons/git-fork';
	import Copy from '@lucide/svelte/icons/copy';
	import Moon from '@lucide/svelte/icons/moon';
	import StatusBadge from '$lib/components/molecules/status-badge.svelte';
	import GithubIcon from '$lib/components/atoms/github-icon.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import * as Popover from '$lib/components/atoms/ui/popover';
	import Spinner from '$lib/components/atoms/spinner.svelte';
	import { levelAtLeast, type AccessLevel } from '$lib/domain/access';
	import { cn } from '$lib/utils';

	let { data, children } = $props();
	const p = $derived(data.project);
	const base = $derived(`/projects/${p.slug}`);
	const isAdmin = $derived(data.level === 'admin');
	const can = (need: AccessLevel | 'admin') => (need === 'admin' ? isAdmin : isAdmin || levelAtLeast(data.level as AccessLevel, need));
	const tabs = $derived(
		[
			{ href: base, label: 'Aperçu', icon: LayoutDashboard, need: 'read' as const, exact: true },
			{ href: `${base}/deployments`, label: 'Déploiements', icon: Rocket, need: 'read' as const },
			{ href: `${base}/logs`, label: 'Logs', icon: ScrollText, need: 'read' as const },
			{ href: `${base}/variables`, label: 'Variables', icon: KeyRound, need: 'edit' as const },
			{ href: `${base}/domains`, label: 'Domaines', icon: Globe, need: 'read' as const },
			{ href: `${base}/database`, label: 'Base de données', icon: Database, need: 'edit' as const },
			{ href: `${base}/container`, label: 'Ressources', icon: Gauge, need: 'read' as const },
			{ href: `${base}/settings`, label: 'Paramètres', icon: Settings, need: 'admin' as const }
		].filter((t) => can(t.need))
	);
	const isActive = (t: { href: string; exact?: boolean }) => (t.exact ? page.url.pathname === t.href : page.url.pathname.startsWith(t.href));
	const primary = $derived(data.domains[0]?.fqdn ?? null);
	const site = $derived(primary ? `https://${primary}` : null);

	const reloadProject = coalesce(() => invalidate('forge:project'));
	onJobChange((e) => {
		if (e.slug === p.slug) reloadProject();
	});
	onMount(() => {
		const t = setInterval(() => {
			if (data.activeJob) void invalidate('forge:project');
		}, 3000);
		return () => clearInterval(t);
	});

	let deploying = $state(false);
	let moreOpen = $state(false);
</script>

<header class="animate-rise mb-6 space-y-4">
	<div class="flex flex-wrap items-start justify-between gap-4">
		<div class="min-w-0">
			<div class="flex flex-wrap items-center gap-2.5">
				<h1 class="truncate text-[24px] leading-tight font-semibold tracking-[-0.025em]">{p.name}</h1>
				<StatusBadge status={p.status} />
				<span class={cn('rounded-sm px-1.5 py-px font-mono text-[10px] font-medium tracking-wider uppercase ring-1 ring-inset', p.environment === 'development' ? 'bg-info/10 text-info ring-info/25' : 'bg-foreground/[0.04] text-muted-foreground ring-border')}>
					{p.environment === 'development' ? 'dev' : 'prod'}
				</span>
				{#if p.sleepingSince}<span class="inline-flex items-center gap-1 rounded-sm bg-info/10 px-1.5 py-px text-xs text-info ring-1 ring-info/25 ring-inset"><Moon class="size-3" /> En veille</span>{/if}
			</div>
			<div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
				{#if site}
					<a href={site} target="_blank" rel="noreferrer" class="inline-flex items-center gap-1 font-mono hover:text-ember">{primary}<ArrowUpRight class="size-3" /></a>
				{/if}
				<a href="https://github.com/{p.repoOwner}/{p.repoName}/tree/{p.branch}" target="_blank" rel="noreferrer" class="inline-flex items-center gap-1.5 font-mono hover:text-foreground">
					<GithubIcon class="size-3.5" />{p.repoOwner}/{p.repoName}<span class="opacity-60">@{p.branch}</span>
				</a>
				{#if data.sibling}
					<a href="/projects/{data.sibling.slug}" class="inline-flex items-center gap-1 hover:text-foreground"><GitFork class="size-3.5" /> {data.sibling.environment === 'development' ? 'Serveur de dev' : 'Serveur de prod'}</a>
				{/if}
			</div>
		</div>

		<div class="flex items-center gap-2">
			{#if site}<Button href={site} target="_blank" rel="noreferrer" variant="outline" size="sm"><ArrowUpRight /> Ouvrir le site</Button>{/if}
			{#if can('deploy') && p.status !== 'draft'}
				<form
					method="POST"
					action="{base}/deployments?/redeploy"
					use:enhance={() => {
						deploying = true;
						return async ({ result, update }) => {
							deploying = false;
							if (result.type === 'failure') toast.error((result.data as { error?: string })?.error ?? 'Impossible de redéployer');
							await update();
						};
					}}
				>
					<Button type="submit" size="sm" disabled={deploying || !!data.activeJob} title={data.activeJob ? 'Un job est déjà en cours sur ce projet' : 'Redéployer le dernier commit'}>
						{#if deploying}<Spinner />{:else}<Rocket />{/if} Redéployer
					</Button>
				</form>
			{/if}
			<Popover.Root bind:open={moreOpen}>
				<Popover.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="ghost" size="icon" aria-label="Plus d'actions"><Ellipsis /></Button>
					{/snippet}
				</Popover.Trigger>
				<Popover.Content align="end" class="w-60 p-1">
					{@render item(`https://github.com/${p.repoOwner}/${p.repoName}`, GithubIcon, 'Voir le dépôt GitHub', true)}
					{#if p.ip}
						<button class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-accent" onclick={() => { void navigator.clipboard.writeText(p.ip ?? ''); toast.success(`IP ${p.ip} copiée`); moreOpen = false; }}>
							<Copy class="size-4 text-muted-foreground" /> Copier l'IP <span class="ml-auto font-mono text-xs text-muted-foreground">{p.ip}</span>
						</button>
					{/if}
					{#if isAdmin && !data.sibling && p.environment === 'production'}
						{@render item(`/projects/new?from=${p.slug}`, Plus, 'Ajouter un serveur de dev')}
					{/if}
					{#if can('read')}{@render item(`${base}/container`, Gauge, 'Allumer, éteindre, redimensionner')}{/if}
					{#if isAdmin}{@render item(`${base}/settings`, Settings, 'Paramètres du projet')}{/if}
				</Popover.Content>
			</Popover.Root>
		</div>
	</div>

	{#if data.activeJob}
		{@const waiting = data.activeJob.status === 'awaiting_input'}
		<a
			href="/jobs/{data.activeJob.id}"
			class={cn(
				'flex items-center gap-3 rounded-lg border px-4 py-2.5 text-sm transition-colors',
				waiting ? 'border-warning/40 bg-warning/5 hover:bg-warning/10' : 'border-info/30 bg-info/5 hover:bg-info/10'
			)}
		>
			{#if waiting}<CircleAlert class="size-4 text-warning" />{:else}<Spinner class="text-info" />{/if}
			<span class="min-w-0 flex-1 truncate">
				<span class="font-medium">{data.activeJob.label}</span>
				<span class="text-muted-foreground"> — {waiting ? 'Forge attend votre confirmation' : (data.activeJob.currentStep ?? 'en file')}</span>
			</span>
			<span class={cn('text-xs font-medium', waiting ? 'text-warning' : 'text-info')}>{waiting ? 'Répondre' : 'Suivre en direct'}</span>
			<ArrowRight class="size-4 text-muted-foreground" />
		</a>
	{/if}

	<nav class="scrollbar-none -mx-1 flex gap-0.5 overflow-x-auto border-b px-1" aria-label="Sections du projet">
		{#each tabs as t (t.href)}
			{@const active = isActive(t)}
			<a
				href={t.href}
				class={cn(
					'group/tab relative -mb-px inline-flex shrink-0 items-center gap-1.5 border-b px-1 pt-0.5 pb-2 text-[13px] font-medium transition-colors',
					active ? 'border-ember text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
				)}
				aria-current={active ? 'page' : undefined}
			>
				<span class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors group-hover/tab:bg-foreground/[0.05]">
					<t.icon class={cn('size-3.5', active ? 'text-ember' : '')} />
					{t.label}
				</span>
			</a>
		{/each}
	</nav>
</header>

<!-- Changer de projet recrée les onglets : aucun état local (variables, taille, base…) ne passe d'un projet à l'autre. -->
{#key p.slug}
	{@render children()}
{/key}

{#snippet item(href: string, Icon: typeof Plus | typeof GithubIcon, label: string, external = false)}
	<a {href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined} class="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-accent" onclick={() => (moreOpen = false)}>
		<Icon class="size-4 text-muted-foreground" /> {label}
	</a>
{/snippet}

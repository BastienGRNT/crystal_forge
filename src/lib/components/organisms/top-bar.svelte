<script lang="ts">
	import { page } from '$app/state';
	import Menu from '@lucide/svelte/icons/menu';
	import Search from '@lucide/svelte/icons/search';
	import Activity from '@lucide/svelte/icons/activity';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import FlaskConical from '@lucide/svelte/icons/flask-conical';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CheckCircle from '@lucide/svelte/icons/circle-check';
	import * as Popover from '$lib/components/atoms/ui/popover';
	import { Button } from '$lib/components/atoms/ui/button';
	import Spinner from '$lib/components/atoms/spinner.svelte';
	import RelativeTime from '$lib/components/molecules/relative-time.svelte';
	import { openPalette } from '$lib/palette.svelte';
	import { cn } from '$lib/utils';
	import type { JobSummary } from '$server/application/use-cases/jobs';

	let {
		mode,
		dryRun,
		activeJobList,
		onMenu
	}: { mode: 'live' | 'mock'; dryRun: boolean; activeJobList: JobSummary[]; onMenu: () => void } = $props();

	const SECTIONS: Record<string, string> = {
		projects: 'Projets',
		jobs: 'Activité',
		server: 'Serveur',
		users: 'Utilisateurs',
		settings: 'Réglages',
		account: 'Mon compte'
	};
	const TABS: Record<string, string> = {
		deployments: 'Déploiements',
		logs: 'Logs',
		variables: 'Variables',
		domains: 'Domaines',
		database: 'Base de données',
		container: 'Ressources',
		settings: 'Paramètres'
	};

	/** Fil d'Ariane déduit de l'URL (et du nom du projet quand la page le fournit). */
	const crumbs = $derived.by(() => {
		const parts = page.url.pathname.split('/').filter(Boolean);
		if (parts.length === 0) return [{ label: "Vue d'ensemble", href: '/' }];
		const out: { label: string; href: string }[] = [{ label: SECTIONS[parts[0]!] ?? parts[0]!, href: `/${parts[0]}` }];
		if (parts[0] === 'projects' && parts[1]) {
			if (parts[1] === 'new') out.push({ label: 'Nouveau projet', href: '/projects/new' });
			else {
				const name = (page.data as { project?: { name?: string } }).project?.name ?? parts[1];
				out.push({ label: name, href: `/projects/${parts[1]}` });
				if (parts[2]) out.push({ label: TABS[parts[2]] ?? parts[2], href: page.url.pathname });
			}
		} else if (parts[0] === 'jobs' && parts[1]) {
			out.push({ label: `Job #${parts[1]}`, href: page.url.pathname });
		}
		return out;
	});
	const waiting = $derived(activeJobList.filter((j) => j.status === 'awaiting_input'));
</script>

<header class="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur-md sm:px-5">
	<Button variant="ghost" size="icon-sm" class="lg:hidden" onclick={onMenu} aria-label="Ouvrir le menu"><Menu /></Button>

	<nav aria-label="Fil d'Ariane" class="flex min-w-0 flex-1 items-center gap-1 text-sm">
		{#each crumbs as c, i (c.href)}
			{#if i > 0}<ChevronRight class="size-3.5 shrink-0 text-muted-foreground/50" />{/if}
			{#if i === crumbs.length - 1}
				<span class="truncate font-medium" aria-current="page">{c.label}</span>
			{:else}
				<a href={c.href} class={cn('truncate text-muted-foreground transition-colors hover:text-foreground', i === 0 && crumbs.length > 2 && 'hidden sm:inline')}>{c.label}</a>
			{/if}
		{/each}
	</nav>

	<div class="flex shrink-0 items-center gap-1.5">
		{#if mode === 'mock'}
			<span class="hidden items-center gap-1 rounded-full bg-info/10 px-2 py-0.5 text-[11px] font-medium text-info ring-1 ring-info/25 ring-inset sm:inline-flex" title="Infrastructure simulée : aucune API réelle n'est contactée">
				<FlaskConical class="size-3" /> Démo
			</span>
		{/if}
		{#if dryRun}
			<a href="/settings?tab=security" class="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning ring-1 ring-warning/25 ring-inset" title="DRY-RUN : les écritures sont journalisées mais jamais exécutées. Cliquez pour changer.">
				<ShieldAlert class="size-3" /> Simulation
			</a>
		{/if}

		<Button variant="ghost" size="icon-sm" class="lg:hidden" onclick={openPalette} aria-label="Rechercher"><Search /></Button>

		<Popover.Root>
			<Popover.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="sm" class={cn('gap-1.5', waiting.length ? 'text-warning' : activeJobList.length ? 'text-info' : 'text-muted-foreground')} aria-label="Activité en cours">
						{#if waiting.length}<CircleAlert />{:else if activeJobList.length}<Spinner />{:else}<Activity />{/if}
						{#if activeJobList.length}<span class="tabular-nums">{activeJobList.length}</span>{/if}
						<span class="hidden md:inline">{waiting.length ? 'À confirmer' : activeJobList.length ? 'En cours' : 'Activité'}</span>
					</Button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content align="end" class="w-80 p-0">
				<div class="flex items-center justify-between border-b px-3 py-2.5">
					<p class="text-sm font-medium">Tâches en cours</p>
					<a href="/jobs" class="text-xs text-muted-foreground hover:text-foreground">Tout l'historique →</a>
				</div>
				{#if activeJobList.length === 0}
					<p class="flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground"><CheckCircle class="size-4 text-success" /> Rien en cours. Tout est calme.</p>
				{:else}
					<ul class="max-h-80 divide-y overflow-y-auto">
						{#each activeJobList as j (j.id)}
							<li>
								<a href="/jobs/{j.id}" class="flex items-start gap-2.5 px-3 py-2.5 hover:bg-accent/50">
									{#if j.status === 'awaiting_input'}<CircleAlert class="mt-0.5 size-4 shrink-0 text-warning" />{:else}<Spinner class="mt-0.5 size-4 shrink-0 text-info" />{/if}
									<span class="min-w-0 flex-1">
										<span class="block truncate text-sm font-medium">{j.label}{#if j.project}<span class="font-normal text-muted-foreground"> · {j.project.name}</span>{/if}</span>
										<span class="block truncate text-xs text-muted-foreground">
											{j.status === 'awaiting_input' ? 'Attend votre confirmation' : (j.currentStep ?? 'En file')} · <RelativeTime value={j.createdAt} />
										</span>
									</span>
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</Popover.Content>
		</Popover.Root>
	</div>
</header>

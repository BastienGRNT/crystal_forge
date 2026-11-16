<script lang="ts">
	import { page } from '$app/state';
	import Menu from '@lucide/svelte/icons/menu';
	import Search from '@lucide/svelte/icons/search';
	import Activity from '@lucide/svelte/icons/activity';
	import FlaskConical from '@lucide/svelte/icons/flask-conical';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CheckCircle from '@lucide/svelte/icons/circle-check';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import PanelLeft from '@lucide/svelte/icons/panel-left';
	import Check from '@lucide/svelte/icons/check';
	import Moon from '@lucide/svelte/icons/moon';
	import { goto } from '$app/navigation';
	import StatusDot from '$lib/components/atoms/status-dot.svelte';
	import { statusInfo } from '$lib/status';
	import * as Popover from '$lib/components/atoms/ui/popover';
	import { Button } from '$lib/components/atoms/ui/button';
	import Spinner from '$lib/components/atoms/spinner.svelte';
	import RelativeTime from '$lib/components/molecules/relative-time.svelte';
	import { openPalette } from '$lib/palette.svelte';
	import { cn } from '$lib/utils';
	import type { JobSummary } from '$server/application/use-cases/jobs';
	import NotificationBell, { type NotificationItem } from './notification-bell.svelte';

	type BarProject = { slug: string; name: string; status: string; environment: string; sleeping: boolean };
	let {
		mode,
		dryRun,
		activeJobList,
		projects = [],
		collapsed = false,
		notifications,
		onMenu,
		onToggleSidebar
	}: {
		mode: 'live' | 'mock';
		dryRun: boolean;
		activeJobList: JobSummary[];
		projects?: BarProject[];
		collapsed?: boolean;
		notifications?: { items: NotificationItem[]; unread: number; seenAt: number };
		onMenu: () => void;
		onToggleSidebar?: () => void;
	} = $props();

	const SECTIONS: Record<string, string> = {
		projects: 'Projets',
		jobs: 'Activité',
		server: 'Serveur',
		users: 'Utilisateurs',
		settings: 'Réglages',
		account: 'Mon compte',
		spaces: 'Espaces'
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
		const out: { label: string; href: string; switcher?: boolean }[] = [{ label: SECTIONS[parts[0]!] ?? parts[0]!, href: `/${parts[0]}` }];
		if (parts[0] === 'projects' && parts[1]) {
			if (parts[1] === 'new') out.push({ label: 'Nouveau projet', href: '/projects/new' });
			else {
				const name = (page.data as { project?: { name?: string } }).project?.name ?? parts[1];
				out.push({ label: name, href: `/projects/${parts[1]}`, switcher: true });
				if (parts[2]) out.push({ label: TABS[parts[2]] ?? parts[2], href: page.url.pathname });
			}
		} else if (parts[0] === 'jobs' && parts[1]) {
			out.push({ label: `Job #${parts[1]}`, href: page.url.pathname });
		}
		return out;
	});
	// Sélecteur de projet : on garde l'onglet courant (logs, variables…) en changeant de projet.
	const currentSlug = $derived(page.url.pathname.split('/')[2] ?? '');
	const currentTab = $derived(page.url.pathname.split('/')[3] ?? '');
	let switcherOpen = $state(false);
	let switcherQ = $state('');
	const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
	const switchable = $derived(projects.filter((p) => !switcherQ.trim() || norm(`${p.name} ${p.slug}`).includes(norm(switcherQ.trim()))));
	function switchTo(slug: string) {
		switcherOpen = false;
		switcherQ = '';
		void goto(`/projects/${slug}${currentTab ? `/${currentTab}` : ''}`);
	}
	const waiting = $derived(activeJobList.filter((j) => j.status === 'awaiting_input'));
</script>

<header class="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-background/75 px-3 backdrop-blur-xl sm:px-4">
	<Button variant="ghost" size="icon-sm" class="lg:hidden" onclick={onMenu} aria-label="Ouvrir le menu"><Menu /></Button>
	{#if onToggleSidebar}
		<Button variant="ghost" size="icon-sm" class="hidden text-muted-foreground lg:inline-flex" onclick={onToggleSidebar} aria-label={collapsed ? 'Déplier la barre latérale' : 'Replier la barre latérale'} title={collapsed ? 'Déplier la barre latérale' : 'Replier la barre latérale'}>
			<PanelLeft />
		</Button>
		<span class="hidden h-4 w-px bg-border lg:block"></span>
	{/if}

	<nav aria-label="Fil d'Ariane" class="flex min-w-0 flex-1 items-center gap-0.5 pl-1 text-[13px]">
		{#each crumbs as c, i (c.href)}
			{#if i > 0}<span class="shrink-0 px-1 font-mono text-muted-foreground/40 select-none">/</span>{/if}
			{#if c.switcher && projects.length > 1}
				<span class="flex min-w-0 items-center">
					<a href={c.href} class={cn('truncate rounded-sm px-1 py-0.5 transition-colors hover:text-foreground', i === crumbs.length - 1 ? 'font-medium text-foreground' : 'text-foreground/85')}>{c.label}</a>
					<Popover.Root bind:open={switcherOpen}>
						<Popover.Trigger>
							{#snippet child({ props })}
								<button {...props} class="grid h-6 w-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Changer de projet" title="Changer de projet">
									<ChevronsUpDown class="size-3.5" />
								</button>
							{/snippet}
						</Popover.Trigger>
						<Popover.Content align="start" class="w-72 gap-0 p-0">
							<div class="border-b p-1.5">
								<!-- svelte-ignore a11y_autofocus -->
								<input
									bind:value={switcherQ}
									autofocus
									placeholder="Aller au projet…"
									aria-label="Filtrer les projets"
									class="h-8 w-full rounded-md bg-transparent px-2 text-[13px] outline-none placeholder:text-muted-foreground"
									onkeydown={(e) => {
										if (e.key === 'Enter' && switchable[0]) switchTo(switchable[0].slug);
									}}
								/>
							</div>
							<ul class="scrollbar-thin max-h-72 overflow-y-auto p-1">
								{#each switchable as p (p.slug)}
									{@const st = statusInfo(p.status)}
									<li>
										<button class="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] hover:bg-accent" onclick={() => switchTo(p.slug)}>
											{#if p.sleeping}<Moon class="size-3 text-info" />{:else}<StatusDot tone={st.tone} class="size-1.5" />{/if}
											<span class="flex-1 truncate">{p.name}</span>
											{#if p.environment === 'development'}<span class="font-mono text-[9.5px] tracking-wider text-info/80 uppercase">dev</span>{/if}
											{#if p.slug === currentSlug}<Check class="size-3.5 text-ember" />{/if}
										</button>
									</li>
								{:else}
									<li class="px-2 py-3 text-xs text-muted-foreground">Aucun projet ne correspond.</li>
								{/each}
							</ul>
						</Popover.Content>
					</Popover.Root>
				</span>
			{:else if i === crumbs.length - 1}
				<span class="truncate px-1 font-medium" aria-current="page">{c.label}</span>
			{:else}
				<a href={c.href} class={cn('truncate rounded-sm px-1 py-0.5 text-muted-foreground transition-colors hover:text-foreground', i === 0 && crumbs.length > 2 && 'hidden sm:inline')}>{c.label}</a>
			{/if}
		{/each}
	</nav>

	<div class="flex shrink-0 items-center gap-1.5">
		{#if mode === 'mock'}
			<span class="hidden items-center gap-1 rounded-sm bg-info/10 px-1.5 py-0.5 font-mono text-[10.5px] font-medium tracking-wider text-info uppercase ring-1 ring-info/25 ring-inset sm:inline-flex" title="Infrastructure simulée : aucune API réelle n'est contactée">
				<FlaskConical class="size-3" /> Démo
			</span>
		{/if}
		{#if dryRun}
			<a href="/settings?tab=security" class="inline-flex items-center gap-1 rounded-sm bg-warning/10 px-1.5 py-0.5 font-mono text-[10.5px] font-medium tracking-wider text-warning uppercase ring-1 ring-warning/25 ring-inset" title="DRY-RUN : les écritures sont journalisées mais jamais exécutées. Cliquez pour changer.">
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

		{#if notifications}<NotificationBell {...notifications} />{/if}
	</div>
</header>

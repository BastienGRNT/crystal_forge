<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import { coalesce, onJobChange } from '$lib/live.svelte';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import Hand from '@lucide/svelte/icons/hand';
	import HardDrive from '@lucide/svelte/icons/hard-drive';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import Unplug from '@lucide/svelte/icons/unplug';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Moon from '@lucide/svelte/icons/moon';
	import Anvil from '@lucide/svelte/icons/anvil';
	import StatusDot from '$lib/components/atoms/status-dot.svelte';
	import Meter from '$lib/components/atoms/meter.svelte';
	import RelativeTime from '$lib/components/molecules/relative-time.svelte';
	import EmptyState from '$lib/components/molecules/empty-state.svelte';
	import JobList from '$lib/components/organisms/job-list.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import { bytes, daysUntil, percent, uptime } from '$lib/format';
	import { statusInfo, usageTone, TONE_TEXT, type Tone } from '$lib/status';
	import { cn } from '$lib/utils';
	import { deferred } from '$lib/deferred.svelte';

	let { data } = $props();
	let refreshing = $state(false);
	let showOthers = $state(false);
	/** Jamais deux rechargements en même temps (Proxmox lent = requêtes qui s'empilent). */
	let inFlight = false;

	async function reload() {
		if (inFlight) return;
		inFlight = true;
		try {
			await invalidate('forge:dashboard');
		} finally {
			inFlight = false;
		}
	}
	async function refresh() {
		refreshing = true;
		await reload();
		refreshing = false;
	}
	onJobChange(coalesce(reload, 1000));
	onMount(() => {
		const t = setInterval(() => {
			if (document.visibilityState === 'visible') void reload();
		}, 30_000);
		return () => clearInterval(t);
	});

	const github = deferred(() => data.github);
	const cards = $derived(
		data.cards.map((c) => {
			const gh = github.value?.byVmid[c.vmid];
			return gh ? { ...c, repo: gh.repo, lastRun: gh.lastRun } : c;
		})
	);
	const projectCards = $derived(cards.filter((c) => c.kind === 'forge' || c.kind === 'orphan'));
	const otherCards = $derived(cards.filter((c) => c.kind === 'readonly' || c.kind === 'template'));
	const sleeping = $derived(new Set((page.data.projects as { slug: string; sleeping: boolean }[]).filter((p) => p.sleeping).map((p) => p.slug)));

	// --- À traiter : tout ce qui demande une action, au même endroit ------------------------------
	interface Item {
		tone: Tone;
		icon: typeof TriangleAlert;
		title: string;
		detail: string;
		href: string;
		cta: string;
	}
	const attention = $derived.by<Item[]>(() => {
		const out: Item[] = [];
		for (const e of data.errors) out.push({ tone: 'danger', icon: Unplug, title: `${e.system} injoignable`, detail: e.message, href: '/settings?tab=connections', cta: 'Vérifier' });
		if (github.value?.error) out.push({ tone: 'danger', icon: Unplug, title: 'GitHub injoignable', detail: github.value.error, href: '/settings?tab=github', cta: 'Vérifier' });
		for (const j of data.awaiting) out.push({ tone: 'warning', icon: Hand, title: `${j.label} attend votre confirmation`, detail: j.project?.name ?? 'Forge', href: `/jobs/${j.id}`, cta: 'Répondre' });
		for (const j of data.failed) out.push({ tone: 'danger', icon: CircleX, title: `${j.label} a échoué`, detail: `${j.project?.name ?? 'Forge'} · ${j.error ?? ''}`, href: `/jobs/${j.id}`, cta: 'Voir le journal' });
		for (const c of projectCards) {
			const name = c.project?.name ?? c.name;
			if (c.project?.status === 'error' && !data.failed.some((j) => j.project?.slug === c.project?.slug))
				out.push({ tone: 'danger', icon: CircleX, title: `${name} est en erreur`, detail: 'Le dernier job sur ce projet a échoué.', href: `/projects/${c.project.slug}`, cta: 'Ouvrir' });
			if (c.maxdisk && c.disk / c.maxdisk >= 0.85)
				out.push({ tone: c.disk / c.maxdisk >= 0.95 ? 'danger' : 'warning', icon: HardDrive, title: `Disque de ${name} presque plein`, detail: `${percent(c.disk / c.maxdisk)} utilisé (${bytes(c.disk)} / ${bytes(c.maxdisk)})`, href: c.project ? `/projects/${c.project.slug}/container` : '/server', cta: 'Agrandir' });
			for (const d of c.domains) {
				const days = daysUntil(d.certExpiresOn);
				if (days !== null && days <= 14)
					out.push({ tone: days <= 3 ? 'danger' : 'warning', icon: ShieldAlert, title: `Certificat de ${d.fqdn} ${days < 0 ? 'expiré' : `expire dans ${days} j`}`, detail: name, href: c.project ? `/projects/${c.project.slug}/domains` : '/server', cta: 'Voir' });
			}
		}
		return out;
	});

	const host = $derived(data.host);
	const disk = $derived(host ? (host.storage ?? { total: host.rootfs.total, used: host.rootfs.used }) : null);
	const online = $derived(projectCards.filter((c) => c.status === 'running').length);
	const greeting = $derived(new Date().getHours() < 18 ? 'Bonjour' : 'Bonsoir');
</script>

<svelte:head><title>Vue d'ensemble · Forge</title></svelte:head>

<div class="space-y-8">
	<!-- En-tête : une phrase qui dit l'essentiel -->
	<header class="flex flex-wrap items-end justify-between gap-4">
		<div>
			<h1 class="text-2xl font-semibold tracking-tight">{greeting} {page.data.user.username}</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				{online} projet{online > 1 ? 's' : ''} en ligne sur {projectCards.length}
				· {#if attention.length}<span class="font-medium text-warning">{attention.length} point{attention.length > 1 ? 's' : ''} à traiter</span>{:else}<span class="text-success">tout va bien</span>{/if}
				· <span class="text-xs">mis à jour <RelativeTime value={data.fetchedAt} /></span>
			</p>
		</div>
		<div class="flex gap-2">
			<Button variant="ghost" size="icon" onclick={refresh} disabled={refreshing} aria-label="Actualiser" title="Actualiser">
				<RefreshCw class={cn(refreshing && 'animate-spin')} />
			</Button>
			<Button href="/projects/new" size="sm"><Plus /> Nouveau projet</Button>
		</div>
	</header>

	<!-- À traiter -->
	{#if attention.length}
		<section class="overflow-hidden rounded-xl border border-warning/30 bg-card">
			<h2 class="flex items-center gap-2 border-b bg-warning/5 px-4 py-2.5 text-sm font-semibold"><TriangleAlert class="size-4 text-warning" /> À traiter</h2>
			<ul class="divide-y">
				{#each attention as a, i (i)}
					{@const Icon = a.icon}
					<li class="flex items-center gap-3 px-4 py-3">
						<Icon class={cn('size-4 shrink-0', TONE_TEXT[a.tone])} />
						<div class="min-w-0 flex-1">
							<p class="text-sm font-medium">{a.title}</p>
							<p class="truncate text-xs text-muted-foreground">{a.detail}</p>
						</div>
						<Button href={a.href} variant="outline" size="sm" class="shrink-0">{a.cta} <ArrowRight /></Button>
					</li>
				{/each}
			</ul>
		</section>
	{:else}
		<div class="flex items-center gap-2.5 rounded-xl border border-success/25 bg-success/5 px-4 py-3 text-sm">
			<CircleCheck class="size-4 text-success" /> Rien à traiter : aucun échec, aucune alerte disque ni certificat.
		</div>
	{/if}

	<!-- Serveur, en une ligne -->
	{#if host && disk}
		<a href="/server" class="group grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border transition-colors hover:border-foreground/20 md:grid-cols-4">
			{@render stat('Processeur', percent(host.cpu), `${host.cpus} cœurs`, host.cpu)}
			{@render stat('Mémoire', bytes(host.memory.used), `sur ${bytes(host.memory.total)}`, host.memory.used / host.memory.total)}
			{@render stat('Stockage', bytes(disk.used), `sur ${bytes(disk.total)}`, disk.used / disk.total)}
			<div class="flex flex-col justify-between bg-card px-4 py-3">
				<span class="text-xs text-muted-foreground">Serveur {data.node}</span>
				<span class="mt-1 flex items-center justify-between text-sm font-medium">en marche depuis {uptime(host.uptime)} <ArrowRight class="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" /></span>
			</div>
		</a>
	{/if}

	<!-- Projets -->
	<section class="space-y-3">
		<div class="flex items-center justify-between">
			<h2 class="text-sm font-semibold">Projets</h2>
			<a href="/projects" class="text-xs text-muted-foreground hover:text-foreground">Tous les projets →</a>
		</div>
		{#if projectCards.length}
			<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
				{#each projectCards as c (c.vmid)}
					{@const st = c.project ? statusInfo(c.project.status === 'active' ? c.status : c.project.status) : statusInfo(c.status)}
					{@const asleep = !!c.project && sleeping.has(c.project.slug)}
					{@const d0 = c.domains[0]}
					{@const url = d0 ? `https://${d0.fqdn}` : null}
					<article class="group relative flex flex-col gap-3 rounded-xl border bg-card p-4 transition-all hover:border-foreground/20 hover:shadow-md">
						<div class="flex items-start justify-between gap-2">
							<div class="min-w-0">
								<a href={c.project ? `/projects/${c.project.slug}` : '/server'} class="flex items-center gap-2 font-medium after:absolute after:inset-0">
									{#if asleep}<Moon class="size-3.5 text-info" />{:else}<StatusDot tone={st.tone} pulse={st.pulse} />{/if}
									<span class="truncate">{c.project?.name ?? c.name}</span>
								</a>
								<p class="mt-0.5 truncate text-xs text-muted-foreground">
									{asleep ? 'En veille · se réveille à la première visite' : c.kind === 'orphan' ? `CT ${c.vmid} sans projet` : st.label}
								</p>
							</div>
							{#if url && d0}
								<a href={url} target="_blank" rel="noreferrer" class="relative z-10 -mr-1 -mt-1 rounded-md p-1.5 text-muted-foreground opacity-60 transition hover:bg-accent hover:text-foreground group-hover:opacity-100" title="Ouvrir {d0.fqdn}">
									<ArrowUpRight class="size-4" />
								</a>
							{/if}
						</div>
						{#if d0}<p class="truncate font-mono text-xs text-muted-foreground">{d0.fqdn}{c.domains.length > 1 ? ` +${c.domains.length - 1}` : ''}</p>{/if}
						<div class="mt-auto grid grid-cols-2 gap-3 text-[11px] text-muted-foreground">
							<div>
								<div class="mb-1 flex justify-between"><span>RAM</span><span class={TONE_TEXT[usageTone(c.maxmem ? c.mem / c.maxmem : 0)]}>{c.status === 'running' ? bytes(c.mem, 0) : '—'}</span></div>
								<Meter size="sm" value={c.maxmem ? c.mem / c.maxmem : 0} />
							</div>
							<div>
								<div class="mb-1 flex justify-between"><span>Disque</span><span class={TONE_TEXT[usageTone(c.maxdisk ? c.disk / c.maxdisk : 0)]}>{c.maxdisk ? percent(c.disk / c.maxdisk) : '—'}</span></div>
								<Meter size="sm" value={c.maxdisk ? c.disk / c.maxdisk : 0} />
							</div>
						</div>
					</article>
				{/each}
			</div>
		{:else}
			<EmptyState icon={Anvil} title="Aucun projet" description="Déployez un dépôt GitHub sur un conteneur en quelques clics.">
				<Button href="/projects/new" size="sm"><Plus /> Nouveau projet</Button>
			</EmptyState>
		{/if}
	</section>

	<!-- Activité récente -->
	<section class="space-y-3">
		<div class="flex items-center justify-between">
			<h2 class="text-sm font-semibold">Activité récente</h2>
			<a href="/jobs" class="text-xs text-muted-foreground hover:text-foreground">Tout l'historique →</a>
		</div>
		<JobList jobs={data.recentJobs} />
	</section>

	<!-- Autres conteneurs : repliés, ils ne servent qu'à l'occasion -->
	{#if otherCards.length}
		<section class="rounded-xl border bg-card">
			<button class="flex w-full items-center justify-between px-4 py-3 text-sm" onclick={() => (showOthers = !showOthers)} aria-expanded={showOthers}>
				<span><span class="font-semibold">Autres conteneurs</span> <span class="text-muted-foreground">· {otherCards.length}, hors Forge (lecture seule)</span></span>
				<ChevronDown class={cn('size-4 text-muted-foreground transition-transform', showOthers && 'rotate-180')} />
			</button>
			{#if showOthers}
				<ul class="divide-y border-t">
					{#each otherCards as c (c.vmid)}
						{@const st = statusInfo(c.status)}
						<li class="flex items-center gap-3 px-4 py-2.5 text-sm">
							<StatusDot tone={st.tone} />
							<span class="w-12 font-mono text-xs text-muted-foreground">{c.vmid}</span>
							<span class="min-w-0 flex-1 truncate">{c.name}{c.kind === 'template' ? ' (modèle)' : ''}</span>
							<span class="hidden font-mono text-xs text-muted-foreground sm:inline">{c.ip ?? ''}</span>
							<span class="w-20 text-right text-xs text-muted-foreground">{c.status === 'running' ? bytes(c.mem, 0) : st.label}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</div>

{#snippet stat(label: string, value: string, sub: string, ratio: number)}
	<div class="bg-card px-4 py-3">
		<div class="flex items-baseline justify-between gap-2">
			<span class="text-xs text-muted-foreground">{label}</span>
			<span class={cn('text-xs', TONE_TEXT[usageTone(ratio)])}>{percent(ratio)}</span>
		</div>
		<p class="mt-1 text-sm font-medium">{value} <span class="text-xs font-normal text-muted-foreground">{sub}</span></p>
		<Meter size="sm" value={ratio} class="mt-2" />
	</div>
{/snippet}

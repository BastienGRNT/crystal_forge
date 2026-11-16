<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import HeartPulse from '@lucide/svelte/icons/heart-pulse';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import Info from '@lucide/svelte/icons/info';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Terminal from '@lucide/svelte/icons/terminal';
	import Eraser from '@lucide/svelte/icons/eraser';
	import Wrench from '@lucide/svelte/icons/wrench';
	import Hammer from '@lucide/svelte/icons/hammer';
	import { BUILD_CACHE_AUTO_PRUNE_BYTES, formatBytes } from '$lib/domain/build-cache';
	import PageHeader from '$lib/components/molecules/page-header.svelte';
	import SectionCard from '$lib/components/molecules/section-card.svelte';
	import CopyButton from '$lib/components/molecules/copy-button.svelte';
	import RelativeTime from '$lib/components/molecules/relative-time.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import { Skeleton } from '$lib/components/atoms/ui/skeleton';
	import * as Alert from '$lib/components/atoms/ui/alert';
	import type { HealthCheck, HealthStatus } from '$server/application/use-cases/server-health';
	import { cn } from '$lib/utils';

	let { data, form } = $props();
	let refreshing = $state(false);

	const ICON = { ok: CircleCheck, warn: TriangleAlert, error: CircleX, info: Info } satisfies Record<HealthStatus, unknown>;
	const COLOR: Record<HealthStatus, string> = { ok: 'text-success', warn: 'text-warning', error: 'text-danger', info: 'text-info' };

	function grouped(checks: HealthCheck[]) {
		const map = new Map<string, HealthCheck[]>();
		for (const c of checks) map.set(c.group, [...(map.get(c.group) ?? []), c]);
		return [...map];
	}
	const isCommand = (fix: string) => /^(bash|pvesh|vzdump|ssh|pct) /.test(fix);

	async function refresh() {
		refreshing = true;
		await invalidate('forge:server');
		refreshing = false;
	}
</script>

<svelte:head><title>Santé du serveur · Forge</title></svelte:head>

<PageHeader title="Santé du serveur" description="Tout ce dont Forge dépend. Forge entretient seul le serveur toutes les 6 h : sauvegardes de NPM, de Forge et des projets, RAM et priorité CPU des CT, caches de build. Les réglages qui exigent root sur l'hôte sont faits par l'installeur (bash infra/bootstrap.sh).">
	{#snippet actions()}
		<form method="POST" action="?/maintain" use:enhance={() => async ({ update }) => { await update(); await refresh(); }}>
			<Button type="submit" variant="secondary" size="sm"><Wrench /> Entretenir maintenant</Button>
		</form>
		<Button variant="outline" size="sm" onclick={refresh} disabled={refreshing}><RefreshCw class={cn(refreshing && 'animate-spin')} /> Revérifier</Button>
	{/snippet}
</PageHeader>

{#if form && 'error' in form && form.error}
	<Alert.Root variant="destructive" class="mb-6"><Alert.Description>{form.error}</Alert.Description></Alert.Root>
{:else if form && 'maintained' in form && form.maintained}
	{@const m = form.maintained}
	<Alert.Root class={cn('mb-6', m.failed.length ? 'border-warning/40' : 'border-success/40')}>
		<Wrench class={m.failed.length ? 'text-warning' : 'text-success'} />
		<Alert.Description>
			{#if !m.done.length && !m.failed.length}Rien à faire : tout est déjà réglé.{/if}
			{#each m.done as d (d)}<p>✓ {d}</p>{/each}
			{#each m.failed as f (f)}<p class="text-warning">✗ {f}</p>{/each}
		</Alert.Description>
	</Alert.Root>
{:else if form && 'migrated' in form}
	<Alert.Root class="mb-6 border-success/40"><Hammer class="text-success" /><Alert.Description>{form.migrated?.length ? `${form.migrated.length} projet(s) en cours de passage sur le CT de build, l'un après l'autre : suivez-les dans Jobs.` : 'Aucun projet à migrer (ou un job est déjà en cours sur eux).'}</Alert.Description></Alert.Root>
{:else if form && 'pruned' in form}
	<Alert.Root class="mb-6 border-success/40"><Eraser class="text-success" /><Alert.Description>{form.pruned?.length ? `${form.pruned.length} job(s) « Nettoyage du cache de build » en file : suivez-les dans Jobs.` : 'Rien à lancer : un job est déjà en cours sur ces projets.'}</Alert.Description></Alert.Root>
{:else if form && 'queued' in form}
	<Alert.Root class="mb-6 border-success/40"><ShieldCheck class="text-success" /><Alert.Description>{form.queued?.length ? `${form.queued.length} job(s) « Pare-feu du CT » en file : suivez-les dans Jobs.` : 'Tous les pare-feu sont déjà à jour.'}</Alert.Description></Alert.Root>
{/if}

<SectionCard title="CT de build" icon={Hammer} class="mb-6">
	{#await data.builder}
		<Skeleton class="h-10 w-full" />
	{:then b}
		<div class="space-y-3 text-sm">
			<p class="text-muted-foreground">
				Un seul CT construit les images Docker de tous les projets, puis s'éteint après {b.idleMin} min sans build. Les CT des projets ne construisent plus rien : ils n'ont besoin que de la RAM de l'app.
				Chaque push sur la branche d'un projet est détecté par Forge en moins d'une minute et déployé automatiquement (plus de runner ni de workflow GitHub).
			</p>
			<p>
				{#if b.status === 'absent'}<span class="text-muted-foreground">Pas encore créé : il le sera au premier build ({b.cores} cœurs, {b.memoryMb} Mo, {b.diskGb} Go).</span>
				{:else}<span class={b.status === 'running' ? 'text-success' : 'text-muted-foreground'}>CT {b.ctid} · {b.ip} · {b.status === 'running' ? 'allumé' : 'éteint'}</span> · {b.cores} cœurs, {b.memoryMb} Mo, {b.diskGb} Go{/if}
			</p>
			{#if data.runnerProjects.length}
				<div class="rounded-md border border-warning/40 p-3">
					<p class="mb-2">{data.runnerProjects.length} projet(s) utilisent encore l'ancien runner GitHub : {data.runnerProjects.map((p) => p.slug).join(', ')}.</p>
					<p class="mb-3 text-xs text-muted-foreground">La migration redéploie chaque projet par le CT de build, puis retire le runner, le workflow, le secret et les variables du dépôt et nettoie le CT. Les données (volumes, base) ne bougent pas. Si un déploiement échoue, le projet garde son runner.</p>
					<form method="POST" action="?/migrateAll" use:enhance>
						<Button type="submit" size="sm"><Hammer /> Tout migrer vers le CT de build</Button>
					</form>
				</div>
			{:else}
				<p class="text-success">Tous les projets sont déployés par le CT de build.</p>
			{/if}
		</div>
	{/await}
</SectionCard>

{#await data.report}
	<div class="grid gap-6 lg:grid-cols-2">
		{#each Array(4) as _, i (i)}
			<SectionCard title="Vérification…"><div class="space-y-3">{#each Array(3) as __, j (j)}<Skeleton class="h-10 w-full" />{/each}</div></SectionCard>
		{/each}
	</div>
{:then report}
	{@const counts = { ok: report.checks.filter((c) => c.status === 'ok').length, warn: report.checks.filter((c) => c.status === 'warn').length, error: report.checks.filter((c) => c.status === 'error').length }}
	<div class="mb-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
		<span class="inline-flex items-center gap-1.5 text-success"><CircleCheck class="size-4" /> {counts.ok} OK</span>
		<span class="inline-flex items-center gap-1.5 text-warning"><TriangleAlert class="size-4" /> {counts.warn} à surveiller</span>
		<span class="inline-flex items-center gap-1.5 text-danger"><CircleX class="size-4" /> {counts.error} problème(s)</span>
		<span class="text-xs text-muted-foreground">Vérifié <RelativeTime value={report.checkedAt} /></span>
	</div>

	{#if report.memory.length}
		<SectionCard title="RAM réelle par conteneur" icon={HeartPulse} class="mb-6">
			<ul class="space-y-2">
				{#each report.memory as g (g.vmid)}
					{@const pct = g.max ? Math.min(100, Math.round((g.used / g.max) * 100)) : 0}
					<li class="grid grid-cols-[minmax(0,12rem)_1fr_auto] items-center gap-3 text-sm">
						{#if g.slug}<a href="/projects/{g.slug}/container" class="truncate font-mono text-xs hover:underline">{g.slug} · CT {g.vmid}</a>{:else}<span class="truncate font-mono text-xs">{g.name} · CT {g.vmid}</span>{/if}
						<div class="h-2 overflow-hidden rounded-full bg-muted"><div class={cn('h-full rounded-full', pct >= 90 ? 'bg-danger' : pct >= 75 ? 'bg-warning' : 'bg-success')} style="width: {pct}%"></div></div>
						<span class="text-xs whitespace-nowrap text-muted-foreground tabular-nums">{formatBytes(g.used)} / {formatBytes(g.max)}</span>
					</li>
				{/each}
			</ul>
		</SectionCard>
	{/if}

	<div class="grid items-start gap-6 lg:grid-cols-2">
		{#each grouped(report.checks) as [group, checks] (group)}
			<SectionCard title={group} icon={HeartPulse} bodyClass="p-0">
				<ul class="divide-y">
					{#each checks as c (c.id)}
						{@const Icon = ICON[c.status]}
						<li class="space-y-2 px-4 py-3">
							<div class="flex items-start gap-3">
								<Icon class={cn('mt-0.5 size-4 shrink-0', COLOR[c.status])} />
								<div class="min-w-0 flex-1 space-y-0.5">
									<p class="text-sm font-medium">{c.label}</p>
									<p class="text-sm break-words text-muted-foreground">{c.detail}</p>
								</div>
							</div>
							{#if c.fix}
								{#if isCommand(c.fix)}
									<div class="ml-7 flex items-center gap-2 rounded-md bg-terminal px-3 py-1.5 font-mono text-xs text-terminal-foreground">
										<Terminal class="size-3.5 shrink-0 text-white/40" />
										<span class="min-w-0 flex-1 truncate" title={c.fix}>{c.fix}</span>
										<CopyButton value={c.fix} size="icon-xs" />
									</div>
								{:else}
									<p class="ml-7 text-xs text-muted-foreground">→ {c.fix}</p>
								{/if}
							{/if}
							{#if c.caches?.length}
								{@const big = c.caches.filter((x) => x.bytes > BUILD_CACHE_AUTO_PRUNE_BYTES)}
								<div class="ml-7 space-y-1.5">
									<ul class="flex flex-wrap gap-1.5">
										{#each c.caches as x (x.slug)}
											<li class={cn('rounded-md border px-2 py-0.5 font-mono text-xs', x.bytes > BUILD_CACHE_AUTO_PRUNE_BYTES ? 'border-warning/40 text-warning' : 'text-muted-foreground')}>
												{x.slug} · {formatBytes(x.bytes)}
											</li>
										{/each}
									</ul>
									{#if c.caches.some((x) => x.bytes > 0)}
										<form method="POST" action="?/caches" use:enhance>
											{#each big.length ? big : c.caches.filter((x) => x.bytes > 0) as x (x.slug)}<input type="hidden" name="slug" value={x.slug} />{/each}
											<Button type="submit" size="xs" variant="secondary"><Eraser /> Vider {big.length ? `les ${big.length} cache(s) de plus de 2 Go` : 'tous les caches'}</Button>
										</form>
									{/if}
								</div>
							{/if}
							{#if c.projects?.length}
								<div class="ml-7 space-y-1.5">
									<ul class="flex flex-wrap gap-1.5">
										{#each c.projects as p (p.slug)}
											<li>
												<a href="/projects/{p.slug}/container" class={cn('inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-xs hover:bg-muted', p.upToDate ? 'border-success/30 text-success' : 'border-warning/40 text-warning')}>
													{#if p.upToDate}<ShieldCheck class="size-3" />{:else}<TriangleAlert class="size-3" />{/if}
													{p.slug} · CT {p.ctid}
												</a>
											</li>
										{/each}
									</ul>
									{#if c.projects.some((p) => !p.upToDate)}
										<form method="POST" action="?/firewalls" use:enhance>
											<Button type="submit" size="xs" variant="secondary"><ShieldCheck /> Appliquer le pare-feu aux {c.projects.filter((p) => !p.upToDate).length} CT restant(s)</Button>
										</form>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			</SectionCard>
		{/each}
	</div>
{:catch err}
	<Alert.Root variant="destructive"><CircleX /><Alert.Description>{err?.message ?? String(err)}</Alert.Description></Alert.Root>
{/await}

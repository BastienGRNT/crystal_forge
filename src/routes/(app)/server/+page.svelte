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

<PageHeader title="Santé du serveur" description="Tout ce dont Forge dépend, vérifié en lecture seule. Ce qui touche à l'hôte se règle avec les scripts infra/, que vous lancez vous-même : Forge n'a pas d'accès root au Proxmox.">
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={refresh} disabled={refreshing}><RefreshCw class={cn(refreshing && 'animate-spin')} /> Revérifier</Button>
	{/snippet}
</PageHeader>

{#if form && 'error' in form && form.error}
	<Alert.Root variant="destructive" class="mb-6"><Alert.Description>{form.error}</Alert.Description></Alert.Root>
{:else if form && 'queued' in form}
	<Alert.Root class="mb-6 border-success/40"><ShieldCheck class="text-success" /><Alert.Description>{form.queued?.length ? `${form.queued.length} job(s) « Pare-feu du CT » en file : suivez-les dans Jobs.` : 'Tous les pare-feu sont déjà à jour.'}</Alert.Description></Alert.Root>
{/if}

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

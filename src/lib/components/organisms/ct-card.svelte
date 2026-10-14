<script lang="ts">
	import Container from '@lucide/svelte/icons/container';
	import Globe from '@lucide/svelte/icons/globe';
	import GitCommitHorizontal from '@lucide/svelte/icons/git-commit-horizontal';
	import LayoutTemplate from '@lucide/svelte/icons/layout-template';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import StatusDot from '$lib/components/atoms/status-dot.svelte';
	import Meter from '$lib/components/atoms/meter.svelte';
	import LockBadge from '$lib/components/molecules/lock-badge.svelte';
	import StatusBadge from '$lib/components/molecules/status-badge.svelte';
	import RelativeTime from '$lib/components/molecules/relative-time.svelte';
	import { bytes, daysUntil, percent, uptime } from '$lib/format';
	import { runStatus, statusInfo, TONE_TEXT } from '$lib/status';
	import { cn } from '$lib/utils';
	import type { CtCard } from '$server/application/use-cases/dashboard';

	let { card }: { card: CtCard } = $props();
	const s = $derived(statusInfo(card.status));
	const running = $derived(card.status === 'running');
	const href = $derived(card.project ? `/projects/${card.project.slug}` : undefined);
</script>

<svelte:element
	this={href ? 'a' : 'article'}
	{href}
	class={cn(
		'group relative flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 transition-all',
		href && 'hover:-translate-y-0.5 hover:border-foreground/15 hover:shadow-lg hover:shadow-black/10',
		card.kind === 'template' && 'opacity-70'
	)}
>
	<div class="flex items-start justify-between gap-3">
		<div class="flex min-w-0 items-start gap-3">
			<div
				class={cn(
					'grid size-9 shrink-0 place-items-center rounded-lg border',
					card.kind === 'forge' ? 'border-ember/30 bg-ember/10 text-ember' : 'bg-muted/60 text-muted-foreground'
				)}
			>
				{#if card.kind === 'template'}<LayoutTemplate class="size-4" />{:else}<Container class="size-4" />{/if}
			</div>
			<div class="min-w-0">
				<div class="flex items-center gap-2">
					<h3 class="truncate font-medium">{card.project?.name ?? card.name}</h3>
					{#if href}<ArrowUpRight class="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />{/if}
				</div>
				<p class="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-xs text-muted-foreground">
					<span>#{card.vmid}</span>
					{#if card.ip}<span>{card.ip}</span>{/if}
					{#if running && card.uptime}<span class="font-sans">· {uptime(card.uptime)}</span>{/if}
				</p>
			</div>
		</div>
		<div class="flex shrink-0 flex-col items-end gap-1.5">
			{#if card.kind === 'forge' && card.project}
				<StatusBadge status={card.project.status} />
			{:else if card.kind === 'template'}
				<span class="text-xs text-muted-foreground">Template</span>
			{:else if card.kind === 'orphan'}
				<LockBadge reason="Dans le pool forge mais rattaché à aucun projet Forge : lecture seule." />
			{:else}
				<LockBadge />
			{/if}
		</div>
	</div>

	{#if card.kind !== 'template'}
		<div class="flex items-center gap-2 text-xs">
			<StatusDot tone={s.tone} />
			<span class={TONE_TEXT[s.tone]}>{s.label}</span>
		</div>
		<div class="grid grid-cols-2 gap-4">
			<div class="space-y-1.5">
				<div class="flex justify-between text-[11px] text-muted-foreground">
					<span>CPU</span>
					<span class="tabular-nums">{running ? percent(card.cpu, 1) : '—'}</span>
				</div>
				<Meter value={card.cpu} size="sm" />
			</div>
			<div class="space-y-1.5">
				<div class="flex justify-between text-[11px] text-muted-foreground">
					<span>RAM</span>
					<span class="tabular-nums">{running ? `${bytes(card.mem, 0)} / ${bytes(card.maxmem, 0)}` : bytes(card.maxmem, 0)}</span>
				</div>
				<Meter value={card.maxmem ? card.mem / card.maxmem : 0} size="sm" />
			</div>
		</div>
	{/if}

	{#if card.domains.length}
		<ul class="space-y-1">
			{#each card.domains as d (d.fqdn)}
				{@const days = daysUntil(d.certExpiresOn)}
				<li class="flex items-center gap-2 text-xs">
					<Globe class="size-3.5 shrink-0 text-muted-foreground" />
					<span class="min-w-0 truncate font-mono">{d.fqdn}</span>
					{#if days !== null}
						<span class={cn('ml-auto inline-flex shrink-0 items-center gap-1', days < 15 ? 'text-warning' : 'text-muted-foreground')} title="Certificat Let's Encrypt">
							<ShieldCheck class="size-3" />{days} j
						</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if card.lastRun}
		{@const rs = runStatus(card.lastRun.status, card.lastRun.conclusion)}
		<div class="mt-auto flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
			<GitCommitHorizontal class="size-3.5 shrink-0" />
			<StatusDot tone={rs.tone} pulse={rs.pulse} />
			<span class="min-w-0 truncate">#{card.lastRun.runNumber} {card.lastRun.commitMessage ?? ''}</span>
			<span class="ml-auto shrink-0"><RelativeTime value={card.lastRun.createdAt} /></span>
		</div>
	{:else if card.repo}
		<div class="mt-auto border-t pt-3 font-mono text-xs text-muted-foreground">{card.repo}</div>
	{/if}
</svelte:element>

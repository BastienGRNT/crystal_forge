<script lang="ts">
	/** Disponibilité des adresses d'un projet : % en ligne, temps de réponse, barre d'historique, pannes. */
	import { onMount } from 'svelte';
	import Radar from '@lucide/svelte/icons/radar';
	import Moon from '@lucide/svelte/icons/moon';
	import StatusDot from '$lib/components/atoms/status-dot.svelte';
	import RelativeTime from '$lib/components/molecules/relative-time.svelte';
	import { duration } from '$lib/format';
	import { cn } from '$lib/utils';
	import type { DomainUptime } from '$server/application/use-cases/monitor';

	let { slug, compact = false, class: className = '' }: { slug: string; compact?: boolean; class?: string } = $props();

	type Range = '24h' | '7d';
	let range = $state<Range>('24h');
	let data = $state<{ sleeping: boolean; domains: DomainUptime[] } | null>(null);
	let error = $state<string | null>(null);

	async function load() {
		try {
			const r = await fetch(`/api/projects/${slug}/uptime?range=${range}`);
			const j = await r.json();
			if (j.error) error = j.error;
			else {
				data = j;
				error = null;
			}
		} catch {
			error = 'Surveillance indisponible.';
		}
	}
	$effect(() => {
		void range;
		void slug;
		void load();
	});
	onMount(() => {
		const t = setInterval(() => document.visibilityState === 'visible' && load(), 60_000);
		return () => clearInterval(t);
	});

	const pct = (r: number | null) => (r == null ? '—' : `${(r * 100).toFixed(r >= 0.9995 ? 0 : r >= 0.99 ? 2 : 1)} %`);
	const tone = (r: number | null) => (r == null ? 'bg-muted' : r >= 0.999 ? 'bg-success' : r >= 0.97 ? 'bg-warning' : 'bg-danger');
	const fmtBucket = (t: number) => new Date(t).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
</script>

<section class={cn('rounded-lg border bg-card', className)}>
	<div class="flex items-center justify-between gap-3 border-b px-4 py-2.5">
		<h2 class="flex items-center gap-2 text-[13px] font-semibold"><Radar class="size-4 text-muted-foreground" /> Disponibilité</h2>
		<div class="flex rounded-md border bg-background/50 p-0.5" role="tablist" aria-label="Période">
			{#each [{ v: '24h', l: '24 h' }, { v: '7d', l: '7 j' }] as r (r.v)}
				<button role="tab" aria-selected={range === r.v} class={cn('h-6 rounded-sm px-2 font-mono text-[11px] transition-colors', range === r.v ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')} onclick={() => (range = r.v as Range)}>{r.l}</button>
			{/each}
		</div>
	</div>
	{#if error && !data}
		<p class="px-4 py-5 text-sm text-muted-foreground">{error}</p>
	{:else if !data}
		<div class="h-24 animate-pulse"></div>
	{:else if data.domains.length === 0}
		<p class="px-4 py-5 text-sm text-muted-foreground">Aucune adresse à surveiller : ajoutez un domaine.</p>
	{:else}
		{#if data.sleeping}
			<p class="flex items-center gap-2 border-b px-4 py-2 text-xs text-info"><Moon class="size-3.5" /> En veille : la surveillance est en pause pour ne pas réveiller le site.</p>
		{/if}
		<ul class="divide-y">
			{#each data.domains as d (d.domainId)}
				{@const ratio = range === '24h' ? d.uptime24h : d.uptime7d}
				<li class="space-y-3 px-4 py-3.5">
					<div class="flex flex-wrap items-center gap-x-4 gap-y-1">
						<StatusDot tone={d.up == null ? 'neutral' : d.up ? 'success' : 'danger'} pulse={d.up === false} />
						<span class="min-w-0 flex-1 truncate font-mono text-sm">{d.fqdn}</span>
						<span class="text-xs text-muted-foreground">en ligne <span class={cn('font-mono font-semibold tabular-nums', ratio == null ? '' : ratio >= 0.999 ? 'text-success' : ratio >= 0.97 ? 'text-warning' : 'text-danger')}>{pct(ratio)}</span></span>
						<span class="text-xs text-muted-foreground">réponse <span class="font-mono font-semibold text-foreground tabular-nums">{d.avgMs24h == null ? '—' : `${d.avgMs24h} ms`}</span></span>
						{#if d.lastCheck}<span class="text-[11px] text-muted-foreground/80">vérifié <RelativeTime value={d.lastCheck} /></span>{/if}
					</div>
					<div class="flex h-7 items-stretch gap-[2px]" aria-label="Historique de disponibilité">
						{#each d.buckets as b (b.from)}
							<span
								class={cn('flex-1 rounded-[2px] transition-opacity hover:opacity-70', tone(b.ratio), b.ratio == null && 'opacity-40')}
								title="{fmtBucket(b.from)} — {b.ratio == null ? 'aucun relevé' : `${pct(b.ratio)}${b.avgMs != null ? ` · ${b.avgMs} ms` : ''}`}"
							></span>
						{/each}
					</div>
					{#if !compact && d.incidents.length}
						<details class="group">
							<summary class="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">{d.incidents.length} panne{d.incidents.length > 1 ? 's' : ''} sur 7 jours</summary>
							<ul class="mt-2 space-y-1">
								{#each d.incidents as inc (inc.from)}
									<li class="flex items-center gap-2 text-xs">
										<StatusDot tone={inc.to ? 'neutral' : 'danger'} class="size-1.5" />
										<span class="text-muted-foreground">{new Date(inc.from).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</span>
										<span class="font-mono">{inc.to ? duration(inc.to - inc.from) : 'en cours'}</span>
										<span class="truncate text-danger/90">{inc.error}</span>
									</li>
								{/each}
							</ul>
						</details>
					{:else if compact && d.incidents.length}
						<p class="text-xs text-muted-foreground">Dernière panne <RelativeTime value={d.incidents[0]!.from} /> · {d.incidents[0]!.to ? duration(d.incidents[0]!.to - d.incidents[0]!.from) : 'en cours'}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

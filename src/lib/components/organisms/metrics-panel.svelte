<script lang="ts">
	/** Historique CPU / RAM / réseau (Proxmox rrddata) avec choix de la période. */
	import { onMount } from 'svelte';
	import Cpu from '@lucide/svelte/icons/cpu';
	import MemoryStick from '@lucide/svelte/icons/memory-stick';
	import Network from '@lucide/svelte/icons/network';
	import ChartLine from '@lucide/svelte/icons/chart-line';
	import AreaChart from '$lib/components/molecules/area-chart.svelte';
	import Spinner from '$lib/components/atoms/spinner.svelte';
	import { bytes } from '$lib/format';
	import { cn } from '$lib/utils';

	type Range = '1h' | '24h' | '7d';
	type Series = { range: Range; points: { t: number; cpu: number | null; mem: number | null; netin: number | null; netout: number | null }[]; maxmem: number | null; maxcpu: number | null; error?: string };
	let { endpoint, title = 'Historique', class: className = '' }: { endpoint: string; title?: string; class?: string } = $props();

	let range = $state<Range>('1h');
	let data = $state<Series | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(false);

	async function load() {
		loading = true;
		try {
			const r = await fetch(`${endpoint}?range=${range}`);
			const j = (await r.json()) as Series;
			if (j.error) error = j.error;
			else {
				data = j;
				error = null;
			}
		} catch {
			error = 'Historique indisponible.';
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void range;
		void load();
	});
	onMount(() => {
		const t = setInterval(() => {
			if (document.visibilityState === 'visible' && range === '1h') void load();
		}, 60_000);
		return () => clearInterval(t);
	});

	const times = $derived(data?.points.map((p) => p.t) ?? []);
	// CPU : Proxmox donne une fraction de la capacité totale du CT.
	const cpu = $derived(data?.points.map((p) => (p.cpu == null ? null : p.cpu * 100)) ?? []);
	const mem = $derived(data?.points.map((p) => p.mem) ?? []);
	const netin = $derived(data?.points.map((p) => p.netin) ?? []);
	const netout = $derived(data?.points.map((p) => p.netout) ?? []);
	const lastOf = (a: (number | null)[]) => [...a].reverse().find((v) => v != null) ?? null;
	const avgOf = (a: (number | null)[]) => {
		const v = a.filter((x): x is number => x != null);
		return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
	};
	const pct = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)} %`;
	const rate = (v: number) => `${bytes(v)}/s`;
	const RANGES: { v: Range; label: string }[] = [
		{ v: '1h', label: '1 h' },
		{ v: '24h', label: '24 h' },
		{ v: '7d', label: '7 j' }
	];
</script>

<section class={cn('rounded-lg border bg-card', className)}>
	<div class="flex items-center justify-between gap-3 border-b px-4 py-2.5">
		<h2 class="flex items-center gap-2 text-[13px] font-semibold"><ChartLine class="size-4 text-muted-foreground" /> {title} {#if loading}<Spinner class="size-3 text-muted-foreground" />{/if}</h2>
		<div class="flex rounded-md border bg-background/50 p-0.5" role="tablist" aria-label="Période">
			{#each RANGES as r (r.v)}
				<button role="tab" aria-selected={range === r.v} class={cn('h-6 rounded-sm px-2 font-mono text-[11px] transition-colors', range === r.v ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')} onclick={() => (range = r.v)}>{r.label}</button>
			{/each}
		</div>
	</div>
	{#if error && !data}
		<p class="px-4 py-8 text-center text-sm text-muted-foreground">{error}</p>
	{:else if !data}
		<div class="grid gap-px bg-border md:grid-cols-3">{#each Array(3) as _, i (i)}<div class="h-[178px] animate-pulse bg-card"></div>{/each}</div>
	{:else if data.points.length === 0}
		<p class="px-4 py-8 text-center text-sm text-muted-foreground">Pas encore d'historique : le conteneur n'existe pas.</p>
	{:else}
		<div class="grid divide-y md:grid-cols-3 md:divide-x md:divide-y-0">
			{@render block(Cpu, 'Processeur', lastOf(cpu) == null ? '—' : pct(lastOf(cpu)!), `moy. ${avgOf(cpu) == null ? '—' : pct(avgOf(cpu)!)}${data.maxcpu ? ` · ${data.maxcpu} cœur${data.maxcpu > 1 ? 's' : ''}` : ''}`, [{ label: 'CPU', color: 'var(--ember)', values: cpu }], pct, null)}
			{@render block(MemoryStick, 'Mémoire', lastOf(mem) == null ? '—' : bytes(lastOf(mem)!), data.maxmem ? `sur ${bytes(data.maxmem)}` : '', [{ label: 'RAM', color: 'var(--info)', values: mem }], (v) => bytes(v), data.maxmem)}
			{@render block(Network, 'Réseau', lastOf(netout) == null ? '—' : rate(lastOf(netout)!), `sortant · entrant ${lastOf(netin) == null ? '—' : rate(lastOf(netin)!)}`, [{ label: 'Sortant', color: 'var(--success)', values: netout }, { label: 'Entrant', color: 'var(--warning)', values: netin }], rate, null)}
		</div>
	{/if}
</section>

{#snippet block(Icon: typeof Cpu, label: string, value: string, sub: string, series: { label: string; color: string; values: (number | null)[] }[], format: (v: number) => string, yMax: number | null)}
	<div class="p-4">
		<p class="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon class="size-3.5" /> {label}</p>
		<p class="mt-1 flex items-baseline gap-2"><span class="font-mono text-lg font-semibold tracking-tight tabular-nums">{value}</span><span class="truncate text-[11px] text-muted-foreground">{sub}</span></p>
		<AreaChart {times} {series} {format} {yMax} height={96} class="mt-3" />
	</div>
{/snippet}

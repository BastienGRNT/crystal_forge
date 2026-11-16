<script lang="ts">
	/**
	 * Courbe en aires, SVG pur : une ou deux séries sur un axe temps.
	 * Survol : ligne verticale + bulle avec les valeurs du point le plus proche.
	 */
	import { cn } from '$lib/utils';

	type Series = { label: string; color: string; values: (number | null)[] };
	let {
		times,
		series,
		format,
		yMax,
		height = 120,
		class: className = ''
	}: {
		times: number[];
		series: Series[];
		format: (v: number) => string;
		/** Plafond fixe (ex. 100 % ou RAM max) ; sinon le max des données. */
		yMax?: number | null;
		height?: number;
		class?: string;
	} = $props();

	const W = 600;
	const H = $derived(height);
	const PAD_T = 6;
	const uid = `ac${Math.random().toString(36).slice(2, 8)}`;

	const top = $derived.by(() => {
		const m = Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v != null)));
		const base = yMax && yMax > 0 ? Math.max(yMax, m) : m * 1.15;
		return base > 0 ? base : 1;
	});
	const x = (i: number) => (times.length <= 1 ? 0 : (i / (times.length - 1)) * W);
	const y = (v: number) => PAD_T + (1 - v / top) * (H - PAD_T);

	function path(values: (number | null)[], close: boolean) {
		let d = '';
		let start = -1;
		let last = -1;
		const segs: string[] = [];
		values.forEach((v, i) => {
			if (v == null) {
				if (start >= 0) segs.push(close ? `${d}L${x(last)},${H}L${x(start)},${H}Z` : d);
				d = '';
				start = -1;
				return;
			}
			d += `${start < 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
			if (start < 0) start = i;
			last = i;
		});
		if (start >= 0) segs.push(close ? `${d}L${x(last)},${H}L${x(start)},${H}Z` : d);
		return segs.join(' ');
	}

	let hover = $state<number | null>(null);
	let box = $state<HTMLDivElement | null>(null);
	function onMove(e: PointerEvent) {
		if (!box || times.length === 0) return;
		const r = box.getBoundingClientRect();
		const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
		hover = Math.round(ratio * (times.length - 1));
	}
	const fmtTime = (t: number) => {
		const d = new Date(t);
		const span = times.length > 1 ? times[times.length - 1]! - times[0]! : 0;
		return span > 36 * 3600_000
			? d.toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
			: d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
	};
	const leftPct = $derived(hover == null || times.length <= 1 ? 0 : (hover / (times.length - 1)) * 100);
</script>

<div
	bind:this={box}
	class={cn('relative w-full touch-none select-none', className)}
	style="height: {H}px"
	role="img"
	aria-label={series.map((s) => s.label).join(', ')}
	onpointermove={onMove}
	onpointerleave={() => (hover = null)}
>
	<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" class="absolute inset-0 size-full overflow-visible">
		<defs>
			{#each series as s, i (s.label)}
				<linearGradient id="{uid}-{i}" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stop-color={s.color} stop-opacity="0.28" />
					<stop offset="100%" stop-color={s.color} stop-opacity="0" />
				</linearGradient>
			{/each}
		</defs>
		{#each [0.25, 0.5, 0.75] as g (g)}
			<line x1="0" x2={W} y1={PAD_T + g * (H - PAD_T)} y2={PAD_T + g * (H - PAD_T)} stroke="var(--border)" stroke-dasharray="2 4" vector-effect="non-scaling-stroke" />
		{/each}
		<line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} stroke="var(--border)" vector-effect="non-scaling-stroke" />
		{#each series as s, i (s.label)}
			<path d={path(s.values, true)} fill="url(#{uid}-{i})" />
			<path d={path(s.values, false)} fill="none" stroke={s.color} stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
		{/each}
	</svg>
	<span class="pointer-events-none absolute top-0 right-0 font-mono text-[10px] text-muted-foreground/70 tabular-nums">{format(top)}</span>

	{#if hover != null && times[hover] != null}
		<div class="pointer-events-none absolute inset-y-0 w-px bg-foreground/30" style="left: {leftPct}%"></div>
		{#each series as s (s.label)}
			{@const v = s.values[hover]}
			{#if v != null}<span class="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card" style="left: {leftPct}%; top: {(y(v) / H) * 100}%; background: {s.color}"></span>{/if}
		{/each}
		<div
			class="pointer-events-none absolute -top-1 z-10 min-w-32 -translate-y-full rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-lg"
			style="left: {leftPct}%; transform: translate({leftPct > 70 ? '-100%' : leftPct < 30 ? '0' : '-50%'}, -100%)"
		>
			<p class="mb-1 text-[10.5px] text-muted-foreground">{fmtTime(times[hover]!)}</p>
			{#each series as s (s.label)}
				{@const v = s.values[hover]}
				<p class="flex items-center gap-1.5 whitespace-nowrap">
					<span class="size-2 rounded-full" style="background: {s.color}"></span>
					<span class="text-muted-foreground">{s.label}</span>
					<span class="ml-auto pl-3 font-mono font-medium tabular-nums">{v == null ? '—' : format(v)}</span>
				</p>
			{/each}
		</div>
	{/if}
</div>

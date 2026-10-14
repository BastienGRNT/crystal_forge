<script lang="ts" module>
	export interface LogLine {
		id: number;
		ts: number;
		level: string;
		stepKey: string | null;
		message: string;
	}
</script>

<script lang="ts">
	import { onMount, tick } from 'svelte';
	import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line';
	import WrapText from '@lucide/svelte/icons/text-wrap';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import CopyButton from '$lib/components/molecules/copy-button.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import { time } from '$lib/format';
	import { cn } from '$lib/utils';

	let {
		logs,
		title = 'Journal',
		filter = null,
		height = '32rem',
		live = false,
		raw = false
	}: { logs: LogLine[]; title?: string; filter?: string | null; height?: string; live?: boolean; raw?: boolean } = $props();

	let viewport: HTMLDivElement | undefined = $state();
	let follow = $state(true);
	let wrap = $state(true);
	const shown = $derived(filter ? logs.filter((l) => l.stepKey === filter) : logs);

	const LEVEL: Record<string, { cls: string; tag: string }> = {
		debug: { cls: 'text-white/45', tag: '   ' },
		info: { cls: 'text-white/85', tag: 'INF' },
		success: { cls: 'text-emerald-400', tag: ' OK' },
		warn: { cls: 'text-amber-300', tag: 'WRN' },
		error: { cls: 'text-red-400', tag: 'ERR' },
		dry: { cls: 'text-sky-300', tag: 'DRY' }
	};

	$effect(() => {
		void shown.length;
		if (follow && viewport) void tick().then(() => viewport?.scrollTo({ top: viewport.scrollHeight }));
	});

	onMount(() => {
		requestAnimationFrame(() => viewport?.scrollTo({ top: viewport.scrollHeight }));
	});

	function onScroll() {
		if (!viewport) return;
		follow = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 40;
	}
	const asText = $derived(shown.map((l) => `${time(l.ts)} ${LEVEL[l.level]?.tag ?? l.level} ${l.message}`).join('\n'));
</script>

<div class="overflow-hidden rounded-xl border bg-terminal text-terminal-foreground shadow-inner">
	<div class="flex items-center gap-2 border-b border-white/5 px-3 py-2">
		<div class="flex gap-1.5">
			<span class="size-2.5 rounded-full bg-white/10"></span><span class="size-2.5 rounded-full bg-white/10"></span><span class="size-2.5 rounded-full bg-white/10"></span>
		</div>
		<TerminalIcon class="ml-2 size-3.5 text-white/40" />
		<span class="truncate font-mono text-xs text-white/60">{title}</span>
		{#if live}
			<span class="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
				<span class="size-1.5 animate-pulse rounded-full bg-emerald-400"></span> en direct
			</span>
		{/if}
		<div class="ml-auto flex items-center gap-0.5 text-white/60">
			<Button variant="ghost" size="icon-xs" class="hover:bg-white/10 hover:text-white" onclick={() => (wrap = !wrap)} title="Retour à la ligne" aria-pressed={wrap}><WrapText /></Button>
			<CopyButton value={asText} size="icon-xs" />
		</div>
	</div>
	<div bind:this={viewport} onscroll={onScroll} class="scrollbar-thin relative overflow-auto py-2 font-mono text-[12.5px] leading-[1.6]" style:height>
		{#if shown.length === 0}
			<p class="px-4 py-2 text-white/40">Aucune ligne pour l'instant…</p>
		{/if}
		{#each shown as l (l.id)}
			{@const lv = LEVEL[l.level] ?? LEVEL.info}
			<div class="group flex gap-3 px-4 hover:bg-white/[0.03]">
				{#if !raw}
					<span class="shrink-0 text-white/30 select-none tabular-nums">{time(l.ts)}</span>
					<span class={cn('w-7 shrink-0 select-none', lv?.cls, 'opacity-80')}>{lv?.tag}</span>
				{/if}
				<span class={cn('min-w-0', lv?.cls, wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre')}>{l.message}</span>
			</div>
		{/each}
		{#if live}<div class="px-4 pt-1 text-white/40"><span class="inline-block h-3.5 w-2 animate-pulse bg-white/50 align-middle"></span></div>{/if}
	</div>
	{#if !follow}
		<div class="border-t border-white/5 px-3 py-1.5 text-right">
			<Button
				variant="ghost"
				size="xs"
				class="text-white/70 hover:bg-white/10 hover:text-white"
				onclick={() => {
					follow = true;
					viewport?.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
				}}><ArrowDownToLine /> Suivre</Button
			>
		</div>
	{/if}
</div>

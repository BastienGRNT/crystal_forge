<script lang="ts">
	import type { DiffLine } from '$lib/domain/diff';
	import { cn } from '$lib/utils';

	let { lines, title, maxHeight = '28rem', context = 3 }: { lines: DiffLine[]; title?: string; maxHeight?: string; context?: number } = $props();

	/** Masque les longues zones inchangées (garde `context` lignes autour des modifications). */
	const visible = $derived.by(() => {
		const keep = lines.map((l, i) => l.op !== ' ' || lines.slice(Math.max(0, i - context), i + context + 1).some((x) => x.op !== ' '));
		const out: (DiffLine | { gap: number })[] = [];
		let gap = 0;
		lines.forEach((l, i) => {
			if (keep[i]) {
				if (gap) out.push({ gap });
				gap = 0;
				out.push(l);
			} else gap++;
		});
		if (gap) out.push({ gap });
		return out;
	});
	const added = $derived(lines.filter((l) => l.op === '+').length);
	const removed = $derived(lines.filter((l) => l.op === '-').length);
</script>

<div class="overflow-hidden rounded-lg border bg-terminal text-terminal-foreground">
	<div class="flex items-center justify-between border-b border-white/5 px-3 py-1.5 font-mono text-xs">
		<span class="truncate text-white/50">{title ?? ''}</span>
		<span><span class="text-emerald-400">+{added}</span> <span class="text-red-400">−{removed}</span></span>
	</div>
	<pre class="scrollbar-thin overflow-auto py-2 text-[12.5px] leading-relaxed" style:max-height={maxHeight}><code>{#each visible as l, i (i)}{#if 'gap' in l}<span class="block px-3 text-white/30 select-none">⋯ {l.gap} ligne(s) inchangée(s)</span>{:else}<span class={cn('flex pr-4 whitespace-pre', l.op === '+' && 'bg-emerald-500/15 text-emerald-200', l.op === '-' && 'bg-red-500/15 text-red-200')}><span class="w-6 shrink-0 text-center text-white/40 select-none">{l.op}</span>{l.text || ' '}</span>{/if}{/each}</code></pre>
</div>

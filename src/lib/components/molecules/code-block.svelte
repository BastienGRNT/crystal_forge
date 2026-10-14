<script lang="ts">
	import CopyButton from './copy-button.svelte';
	import { cn } from '$lib/utils';

	let { code, title, class: className = '', maxHeight = '28rem' }: { code: string; title?: string; class?: string; maxHeight?: string } = $props();
	const lines = $derived(code.replace(/\n$/, '').split('\n'));
</script>

<div class={cn('overflow-hidden rounded-lg border bg-terminal text-terminal-foreground', className)}>
	<div class="flex items-center justify-between border-b border-white/5 px-3 py-1.5">
		<span class="truncate font-mono text-xs text-white/50">{title ?? ''}</span>
		<CopyButton value={code} size="icon-xs" />
	</div>
	<pre class="scrollbar-thin overflow-auto py-2 text-[12.5px] leading-relaxed" style:max-height={maxHeight}><code>{#each lines as line, i (i)}<span class="flex"><span class="w-10 shrink-0 pr-3 text-right text-white/25 select-none">{i + 1}</span><span class="pr-4 whitespace-pre">{line || ' '}</span></span>{/each}</code></pre>
</div>

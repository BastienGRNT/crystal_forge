<script lang="ts">
	import { cn } from '$lib/utils';

	let { columns, rows, class: className = '', maxHeight = '28rem' }: { columns: string[]; rows: string[][]; class?: string; maxHeight?: string } = $props();
</script>

<div class={cn('scrollbar-thin overflow-auto rounded-lg border', className)} style:max-height={maxHeight}>
	{#if columns.length === 0}
		<p class="px-3 py-8 text-center text-sm text-muted-foreground">Aucune colonne.</p>
	{:else}
		<table class="w-max min-w-full border-collapse text-left font-mono text-[12.5px]">
			<thead class="sticky top-0 z-10 bg-muted/90 backdrop-blur">
				<tr>
					<th class="w-10 border-b px-2 py-1.5 text-right font-normal text-muted-foreground/60">#</th>
					{#each columns as c, i (i)}<th class="border-b border-l px-3 py-1.5 font-medium whitespace-nowrap">{c}</th>{/each}
				</tr>
			</thead>
			<tbody>
				{#each rows as r, i (i)}
					<tr class="hover:bg-muted/40">
						<td class="border-b px-2 py-1 text-right text-muted-foreground/60 select-none">{i + 1}</td>
						{#each columns as _, j (j)}
							{@const v = r[j] ?? ''}
							<td class="max-w-[28rem] truncate border-b border-l px-3 py-1" title={v.length > 40 ? v : undefined}>
								{#if v === ''}<span class="text-muted-foreground/50">∅</span>{:else}{v}{/if}
							</td>
						{/each}
					</tr>
				{:else}
					<tr><td colspan={columns.length + 1} class="px-3 py-8 text-center font-sans text-sm text-muted-foreground">Aucune ligne.</td></tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<script lang="ts">
	import Cpu from '@lucide/svelte/icons/cpu';
	import MemoryStick from '@lucide/svelte/icons/memory-stick';
	import HardDrive from '@lucide/svelte/icons/hard-drive';
	import { assessHostRam, SIZES, type SizeKey } from '$lib/domain/sizes';
	import { cn } from '$lib/utils';

	let { value = $bindable<SizeKey>('M'), freeMb, totalMb }: { value?: SizeKey; freeMb: number | null; totalMb: number | null } = $props();
</script>

<div class="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Taille du conteneur">
	{#each Object.values(SIZES) as s (s.key)}
		{@const ram = freeMb !== null && totalMb !== null ? assessHostRam(totalMb, totalMb - freeMb, s) : null}
		{@const active = value === s.key}
		<button
			type="button"
			role="radio"
			aria-checked={active}
			onclick={() => (value = s.key)}
			class={cn(
				'relative rounded-xl border p-4 text-left transition-all',
				active ? 'border-ember/60 bg-ember/5 ring-2 ring-ember/25' : 'hover:border-foreground/20 hover:bg-accent/30'
			)}
		>
			<div class="flex items-center justify-between">
				<span class="text-lg font-semibold">{s.key}</span>
				<span class="text-xs text-muted-foreground">{s.label}</span>
			</div>
			<ul class="mt-3 space-y-1.5 text-sm">
				<li class="flex items-center gap-2"><Cpu class="size-3.5 text-muted-foreground" /> {s.cores} cœur{s.cores > 1 ? 's' : ''}</li>
				<li class="flex items-center gap-2"><MemoryStick class="size-3.5 text-muted-foreground" /> {s.memoryMb / 1024} Go RAM <span class="text-xs text-muted-foreground">+ {s.swapMb} Mo swap</span></li>
				<li class="flex items-center gap-2"><HardDrive class="size-3.5 text-muted-foreground" /> {s.diskGb} Go disque</li>
			</ul>
			{#if ram}
				<p
					class={cn(
						'mt-3 border-t pt-2 text-xs',
						ram.level === 'ok' && 'text-muted-foreground',
						ram.level === 'tight' && 'text-warning',
						ram.level === 'insufficient' && 'text-danger'
					)}
				>
					{#if ram.level === 'insufficient'}RAM insuffisante sur l'hôte
					{:else}Reste {(ram.afterMb / 1024).toFixed(1)} Go libres sur l'hôte{/if}
				</p>
			{/if}
		</button>
	{/each}
</div>

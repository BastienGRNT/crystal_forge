<script lang="ts">
	import type { Snippet } from 'svelte';
	import Logo from '$lib/components/atoms/logo.svelte';

	let { title, subtitle, children, footer }: { title: string; subtitle?: string; children: Snippet; footer?: Snippet } = $props();
</script>

<div class="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-10">
	<div class="bg-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)]"></div>
	<div class="pointer-events-none absolute -top-40 left-1/2 h-80 w-[40rem] -translate-x-1/2 rounded-full bg-ember/15 blur-3xl"></div>
	<div class="relative w-full max-w-sm">
		<div class="mb-8 flex justify-center"><Logo class="text-lg" /></div>
		<div class="rounded-2xl border bg-card/80 p-6 shadow-2xl shadow-black/20 backdrop-blur">
			<div class="mb-5 space-y-1 text-center">
				<h1 class="text-lg font-semibold tracking-tight">{title}</h1>
				{#if subtitle}<p class="text-sm text-muted-foreground text-balance">{subtitle}</p>{/if}
			</div>
			{@render children()}
		</div>
		{#if footer}<div class="mt-6 text-center text-xs text-muted-foreground">{@render footer()}</div>{/if}
	</div>
</div>

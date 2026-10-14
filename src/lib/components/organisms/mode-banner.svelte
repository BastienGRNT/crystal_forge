<script lang="ts">
	import FlaskConical from '@lucide/svelte/icons/flask-conical';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';

	let { mode, dryRun }: { mode: 'live' | 'mock'; dryRun: boolean } = $props();
</script>

{#if mode === 'mock' || dryRun}
	<div class="flex flex-wrap items-center justify-center gap-x-6 gap-y-1 border-b px-4 py-1.5 text-xs font-medium">
		{#if mode === 'mock'}
			<span class="inline-flex items-center gap-1.5 text-info">
				<FlaskConical class="size-3.5" />
				Mode démo : infrastructure simulée, aucune API réelle n'est contactée
			</span>
		{/if}
		{#if dryRun}
			<span class="inline-flex items-center gap-1.5 text-warning">
				<ShieldAlert class="size-3.5" />
				DRY-RUN : les écritures sont journalisées mais jamais exécutées
			</span>
		{/if}
	</div>
{/if}

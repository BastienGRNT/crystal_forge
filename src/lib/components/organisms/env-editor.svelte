<script lang="ts">
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import { Textarea } from '$lib/components/atoms/ui/textarea';
	import { Button } from '$lib/components/atoms/ui/button';
	import { maskValue, parseEnv } from '$lib/domain/env-file';
	import { cn } from '$lib/utils';

	let { value = $bindable(''), name = 'env', rows = 10 }: { value?: string; name?: string; rows?: number } = $props();
	let hidden = $state(true);
	const parsed = $derived(parseEnv(value));
	const bytes = $derived(new TextEncoder().encode(parsed.normalized).length);
</script>

<div class="grid gap-4 lg:grid-cols-2">
	<div class="space-y-2">
		<div class="relative">
			<Textarea
				{name}
				bind:value
				{rows}
				spellcheck={false}
				autocomplete="off"
				placeholder={'# Collez votre fichier .env tel quel\nDB_USER=app\nDB_PASSWORD=…'}
				class={cn('min-h-56 resize-y font-mono text-[13px] leading-relaxed', hidden && value && '[-webkit-text-security:disc]')}
			/>
			{#if value}
				<Button variant="ghost" size="icon-xs" class="absolute top-2 right-2" onclick={() => (hidden = !hidden)} title={hidden ? 'Afficher' : 'Masquer'}>
					{#if hidden}<Eye />{:else}<EyeOff />{/if}
				</Button>
			{/if}
		</div>
		<p class="text-xs text-muted-foreground">
			Chiffré en base (AES-256-GCM) puis envoyé dans le secret GitHub <code>ENV_FILE</code> (sealed box). Jamais journalisé.
			{#if value}· {bytes} octets / 48 Ko{/if}
		</p>
	</div>
	<div class="space-y-2">
		<div class="rounded-lg border">
			<div class="flex items-center justify-between border-b px-3 py-2 text-xs font-medium text-muted-foreground">
				<span class="inline-flex items-center gap-1.5"><KeyRound class="size-3.5" /> Aperçu</span>
				<span class="inline-flex items-center gap-2">
					{parsed.entries.length} variable{parsed.entries.length > 1 ? 's' : ''}
					{#if parsed.entries.length}
						<!-- Même bascule que l'éditeur : les valeurs sont déjà dans la page. -->
						<Button variant="ghost" size="icon-xs" onclick={() => (hidden = !hidden)} title={hidden ? 'Afficher les valeurs' : 'Masquer les valeurs'}>
							{#if hidden}<Eye />{:else}<EyeOff />{/if}
						</Button>
					{/if}
				</span>
			</div>
			<ul class="scrollbar-thin max-h-56 divide-y overflow-auto text-sm">
				{#each parsed.entries as e (e.key)}
					<li class="flex items-center justify-between gap-3 px-3 py-1.5">
						<span class="max-w-[45%] shrink-0 truncate font-mono text-[13px]" title={e.key}>{e.key}</span>
						{#if hidden || e.value === ''}
							<span class="shrink-0 font-mono text-xs tracking-widest text-muted-foreground">{maskValue(e.value)}</span>
						{:else}
							<span class="min-w-0 truncate font-mono text-xs select-all" title={e.value}>{e.value}</span>
						{/if}
					</li>
				{:else}
					<li class="px-3 py-6 text-center text-xs text-muted-foreground">Aucune variable (optionnel)</li>
				{/each}
			</ul>
		</div>
		{#each parsed.issues as issue, i (i)}
			<p class={cn('flex items-start gap-1.5 text-xs', issue.level === 'error' ? 'text-danger' : 'text-warning')}>
				{#if issue.level === 'error'}<CircleX class="mt-px size-3.5 shrink-0" />{:else}<TriangleAlert class="mt-px size-3.5 shrink-0" />{/if}
				{issue.message}
			</p>
		{/each}
	</div>
</div>

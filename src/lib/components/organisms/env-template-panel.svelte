<script lang="ts">
	import FileText from '@lucide/svelte/icons/file-text';
	import WandSparkles from '@lucide/svelte/icons/wand-sparkles';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import { Button } from '$lib/components/atoms/ui/button';
	import { buildEnvFromTemplate, checkEnvAgainst, randomSecret, type ComposeEnvRef, type EnvTemplate } from '$lib/domain/env-template';
	import { cn } from '$lib/utils';

	let {
		template,
		composeRefs = [],
		value = $bindable(''),
		fqdn = null,
		appPort = 3000,
		/** Mode « onglet Variables » : on ne modifie pas le texte, on signale seulement. */
		readonly = false,
		onfill
	}: {
		template: EnvTemplate | null;
		composeRefs?: ComposeEnvRef[];
		value?: string;
		fqdn?: string | null;
		appPort?: number;
		readonly?: boolean;
		onfill?: (result: { added: string[]; toFill: string[]; text: string }) => void;
	} = $props();

	const check = $derived(checkEnvAgainst(value, template, composeRefs));
	const generated = $derived(template?.entries.filter((e) => e.kind === 'secret').length ?? 0);
	let lastFill = $state<{ added: number; toFill: string[] } | null>(null);

	function fill() {
		if (!template) return;
		const r = buildEnvFromTemplate(template, { fqdn, appPort, generate: () => randomSecret() }, value);
		lastFill = { added: r.added.length, toFill: r.toFill };
		if (readonly) onfill?.(r);
		else value = r.text;
	}
</script>

{#if template || check.missing.length}
	<div class={cn('rounded-lg border p-3 text-sm', check.missing.length || check.unfilled.length ? 'border-info/30 bg-info/5' : 'border-success/30 bg-success/5')}>
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div class="flex min-w-0 items-start gap-2.5">
				<FileText class="mt-0.5 size-4 shrink-0 text-info" />
				<div class="min-w-0 space-y-0.5">
					{#if template}
						<p class="font-medium"><code class="rounded bg-muted px-1">{template.file}</code> détecté · {template.entries.length} variable{template.entries.length > 1 ? 's' : ''}</p>
						<p class="text-xs text-muted-foreground">
							Pré-remplissage : valeurs par défaut du modèle{generated ? `, ${generated} secret(s) générés aléatoirement` : ''}{fqdn ? `, URL publique https://${fqdn}` : ''}, port {appPort}.
						</p>
					{:else}
						<p class="font-medium">Variables attendues par le docker-compose</p>
					{/if}
				</div>
			</div>
			{#if template && check.missing.some((m) => m.from === 'template')}
				<Button type="button" size="sm" variant="secondary" onclick={fill}>
					<WandSparkles />
					{value.trim() ? `Ajouter les ${check.missing.filter((m) => m.from === 'template').length} manquante(s)` : 'Pré-remplir'}
				</Button>
			{/if}
		</div>

		{#if check.missing.length || check.unfilled.length}
			<div class="mt-3 space-y-2 border-t pt-3">
				{#if check.missing.length}
					<div class="flex flex-wrap items-center gap-1.5 text-xs">
						<span class="text-muted-foreground">Absentes du .env :</span>
						{#each check.missing as m (m.key)}
							<code class={cn('rounded px-1.5 py-0.5', m.from === 'compose' ? 'bg-warning/15 text-warning' : 'bg-muted')} title={m.from === 'compose' ? 'Requise par le docker-compose (sans valeur par défaut)' : `Présente dans ${template?.file}`}>{m.key}</code>
						{/each}
					</div>
				{/if}
				{#if check.unfilled.length}
					<p class="flex flex-wrap items-center gap-1.5 text-xs text-warning">
						<TriangleAlert class="size-3.5" /> À remplir (vide ou valeur d'exemple) :
						{#each check.unfilled as k (k)}<code class="rounded bg-warning/15 px-1.5 py-0.5">{k}</code>{/each}
					</p>
				{/if}
			</div>
		{:else}
			<p class="mt-2 flex items-center gap-1.5 text-xs text-success"><CircleCheck class="size-3.5" /> Toutes les variables attendues sont renseignées.</p>
		{/if}
		{#if lastFill && !readonly}
			<p class="mt-2 text-xs text-muted-foreground">{lastFill.added} variable(s) ajoutée(s){lastFill.toFill.length ? ` — à compléter : ${lastFill.toFill.join(', ')}` : ''}.</p>
		{/if}
	</div>
{/if}

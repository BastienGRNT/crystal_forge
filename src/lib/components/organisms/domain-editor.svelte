<script lang="ts" module>
	export interface DomainRow {
		id: number;
		subdomain: string;
		zone: string;
		custom: boolean;
	}
</script>

<script lang="ts">
	import Plus from '@lucide/svelte/icons/plus';
	import X from '@lucide/svelte/icons/x';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { Input } from '$lib/components/atoms/ui/input';
	import { Button } from '$lib/components/atoms/ui/button';
	import * as Select from '$lib/components/atoms/ui/select';
	import Spinner from '$lib/components/atoms/spinner.svelte';
	import { buildFqdn } from '$lib/domain/domain-name';

	let {
		rows = $bindable([]),
		zones,
		publicIp,
		max = 5
	}: { rows?: DomainRow[]; zones: string[]; publicIp: string; max?: number } = $props();

	const OTHER = '__other__';
	type Check = { loading: boolean; ok?: boolean; reasons?: string[]; warnings?: string[]; fqdn?: string };
	let checks = $state<Record<number, Check>>({});
	const timers = new Map<number, ReturnType<typeof setTimeout>>();

	function schedule(row: DomainRow) {
		clearTimeout(timers.get(row.id));
		if (!row.zone) return;
		checks[row.id] = { loading: true };
		timers.set(
			row.id,
			setTimeout(async () => {
				const qs = new URLSearchParams({ sub: row.subdomain, zone: row.zone, managed: row.custom ? '0' : '1' });
				const res = await fetch(`/api/wizard/domain?${qs}`);
				checks[row.id] = { loading: false, ...(await res.json()) };
			}, 450)
		);
	}

	$effect(() => {
		for (const r of rows) {
			void r.subdomain;
			void r.zone;
			void r.custom;
			schedule(r);
		}
	});

	function add() {
		rows.push({ id: Date.now(), subdomain: '', zone: zones[0] ?? '', custom: zones.length === 0 });
	}
</script>

<div class="space-y-3">
	{#each rows as row, i (row.id)}
		{@const check = checks[row.id]}
		<div class="rounded-lg border bg-muted/20 p-3">
			<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
				<div class="flex min-w-0 flex-1 items-center gap-2">
					<Input bind:value={row.subdomain} placeholder="sous-domaine (vide = racine)" class="min-w-0 flex-1 font-mono" aria-label="Sous-domaine" />
					<span class="text-muted-foreground">.</span>
					{#if row.custom}
						<Input bind:value={row.zone} placeholder="exemple.com" class="min-w-0 flex-1 font-mono" aria-label="Domaine" />
					{:else}
						<Select.Root
							type="single"
							value={row.zone}
							onValueChange={(v) => {
								if (v === OTHER) {
									row.custom = true;
									row.zone = '';
								} else row.zone = v;
							}}
						>
							<Select.Trigger class="min-w-40 flex-1 font-mono">{row.zone || 'Zone'}</Select.Trigger>
							<Select.Content>
								{#each zones as z (z)}<Select.Item value={z} label={z} class="font-mono">{z}</Select.Item>{/each}
								<Select.Separator />
								<Select.Item value={OTHER} label="Autre domaine…">Autre domaine (hors OVH)…</Select.Item>
							</Select.Content>
						</Select.Root>
					{/if}
				</div>
				<div class="flex items-center gap-1">
					{#if row.custom && zones.length}
						<Button variant="ghost" size="sm" onclick={() => ((row.custom = false), (row.zone = zones[0] ?? ''))}>Zone OVH</Button>
					{/if}
					{#if rows.length > 1}
						<Button variant="ghost" size="icon-sm" onclick={() => rows.splice(i, 1)} aria-label="Retirer"><X /></Button>
					{/if}
				</div>
			</div>
			<div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
				{#if row.zone}<span class="font-mono text-muted-foreground">https://{buildFqdn(row.subdomain, row.zone)}</span>{/if}
				{#if check?.loading}
					<span class="inline-flex items-center gap-1 text-muted-foreground"><Spinner class="size-3" /> vérification…</span>
				{:else if check?.ok}
					<span class="inline-flex items-center gap-1 text-success"><CircleCheck class="size-3.5" /> disponible</span>
				{:else if check && check.ok === false}
					<span class="inline-flex items-center gap-1 text-danger"><CircleX class="size-3.5" /> {check.reasons?.join(' · ')}</span>
				{/if}
				{#each check?.warnings ?? [] as w (w)}
					<span class="inline-flex items-center gap-1 text-warning"><TriangleAlert class="size-3.5" /> {w}</span>
				{/each}
			</div>
			{#if row.custom && row.zone}
				<p class="mt-2 rounded-md bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
					Hors OVH : créez à la main <span class="font-mono">A {buildFqdn(row.subdomain, row.zone)} → {publicIp}</span> (pas d'AAAA). Forge attendra qu'il résolve.
				</p>
			{/if}
		</div>
	{/each}
	{#if rows.length < max}
		<Button variant="outline" size="sm" onclick={add}><Plus /> Ajouter un domaine</Button>
	{/if}
</div>

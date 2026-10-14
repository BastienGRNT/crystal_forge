<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import Lock from '@lucide/svelte/icons/lock';
	import Anvil from '@lucide/svelte/icons/anvil';
	import PageHeader from '$lib/components/molecules/page-header.svelte';
	import RelativeTime from '$lib/components/molecules/relative-time.svelte';
	import EmptyState from '$lib/components/molecules/empty-state.svelte';
	import HostStats from '$lib/components/organisms/host-stats.svelte';
	import CtCard from '$lib/components/organisms/ct-card.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import * as Alert from '$lib/components/atoms/ui/alert';
	import { cn } from '$lib/utils';
	import { deferred } from '$lib/deferred.svelte';

	let { data } = $props();
	let refreshing = $state(false);
	/** Jamais deux rechargements en même temps (Proxmox lent = requêtes qui s'empilent). */
	let inFlight = false;

	async function reload() {
		if (inFlight) return;
		inFlight = true;
		try {
			await invalidate('forge:dashboard');
		} finally {
			inFlight = false;
		}
	}
	async function refresh() {
		refreshing = true;
		await reload();
		refreshing = false;
	}
	onMount(() => {
		const t = setInterval(() => {
			if (document.visibilityState === 'visible') void reload();
		}, 30_000);
		return () => clearInterval(t);
	});

	// Dépôt et dernier run de chaque CT : lus sur GitHub, arrivent après la page.
	const github = deferred(() => data.github);
	const cards = $derived(
		data.cards.map((c) => {
			const gh = github.value?.byVmid[c.vmid];
			return gh ? { ...c, repo: gh.repo, lastRun: gh.lastRun } : c;
		})
	);
	const forgeCards = $derived(cards.filter((c) => c.kind === 'forge' || c.kind === 'orphan'));
	const otherCards = $derived(cards.filter((c) => c.kind === 'readonly' || c.kind === 'template'));
</script>

<svelte:head><title>Tableau de bord · Forge</title></svelte:head>

<PageHeader title="Tableau de bord" description="État de l'hôte et de tous les conteneurs. Les CT hors du pool forge sont en lecture seule.">
	{#snippet actions()}
		<span class="hidden text-xs text-muted-foreground sm:inline">Mis à jour <RelativeTime value={data.fetchedAt} /></span>
		<Button variant="outline" size="sm" onclick={refresh} disabled={refreshing}>
			<RefreshCw class={cn(refreshing && 'animate-spin')} /> Actualiser
		</Button>
		<Button href="/projects/new" size="sm"><Plus /> Nouveau projet</Button>
	{/snippet}
</PageHeader>

<div class="space-y-8">
	{#each data.errors as e, i (i)}
		<Alert.Root variant="destructive">
			<TriangleAlert />
			<Alert.Title>{e.system} injoignable</Alert.Title>
			<Alert.Description>{e.message}</Alert.Description>
		</Alert.Root>
	{/each}
	{#if github.value?.error}
		<Alert.Root variant="destructive">
			<TriangleAlert />
			<Alert.Title>GitHub injoignable</Alert.Title>
			<Alert.Description>{github.value.error}</Alert.Description>
		</Alert.Root>
	{/if}

	{#if data.host}
		<HostStats host={data.host} node={data.node} />
	{/if}

	<section class="space-y-3">
		<div class="flex items-center justify-between">
			<h2 class="flex items-center gap-2 text-sm font-semibold"><Anvil class="size-4 text-ember" /> Projets Forge <span class="text-muted-foreground">· pool {data.pool}</span></h2>
			<span class="text-xs text-muted-foreground">{forgeCards.length} CT</span>
		</div>
		{#if forgeCards.length}
			<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
				{#each forgeCards as card (card.vmid)}<CtCard {card} />{/each}
			</div>
		{:else}
			<EmptyState icon={Anvil} title="Aucun projet Forge" description="Déployez un dépôt GitHub sur un nouveau conteneur en quelques clics.">
				<Button href="/projects/new" size="sm"><Plus /> Nouveau projet</Button>
			</EmptyState>
		{/if}
	</section>

	<section class="space-y-3">
		<div class="flex items-center justify-between">
			<h2 class="flex items-center gap-2 text-sm font-semibold"><Lock class="size-4 text-muted-foreground" /> Autres conteneurs <span class="text-muted-foreground">· lecture seule</span></h2>
			<span class="text-xs text-muted-foreground">{otherCards.length} invités</span>
		</div>
		<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
			{#each otherCards as card (card.vmid)}<CtCard {card} />{/each}
		</div>
	</section>
</div>

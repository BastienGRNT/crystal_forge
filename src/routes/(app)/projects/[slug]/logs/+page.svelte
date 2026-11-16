<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { getJson, latest } from '$lib/fetch-json';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Search from '@lucide/svelte/icons/search';
	import Radio from '@lucide/svelte/icons/radio';
	import Power from '@lucide/svelte/icons/power';
	import Terminal, { type LogLine } from '$lib/components/organisms/terminal.svelte';
	import EmptyState from '$lib/components/molecules/empty-state.svelte';
	import Spinner from '$lib/components/atoms/spinner.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import * as Alert from '$lib/components/atoms/ui/alert';
	import { cn } from '$lib/utils';
	import { deferred } from '$lib/deferred.svelte';

	let { data } = $props();
	const svc = deferred(() => data.services);
	const services = $derived(svc.value?.services ?? []);

	let service = $state(page.url.searchParams.get('service') ?? '');
	let tail = $state(300);
	let q = $state('');
	let onlyErrors = $state(false);
	let live = $state(false);
	let lines = $state<LogLine[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let loadedAt = $state<number | null>(null);

	const isError = (m: string) => /\b(error|exception|fatal|panic|traceback|failed)\b/i.test(m);
	const isWarn = (m: string) => /\bwarn(ing)?\b/i.test(m);

	const next = latest();
	async function load() {
		if (!data.running) return;
		const current = next();
		loading = true;
		error = null;
		const r = await getJson<{ text: string }>(`/api/projects/${data.project.slug}/logs?${new URLSearchParams({ tail: String(tail), service })}`);
		if (!current()) return;
		loading = false;
		if (!r.ok) {
			error = r.error;
			return;
		}
		loadedAt = Date.now();
		lines = (r.data.text ?? '')
			.split('\n')
			.filter(Boolean)
			.map((message, i) => ({ id: i + 1, ts: Date.now(), level: isError(message) ? 'error' : isWarn(message) ? 'warn' : 'info', stepKey: null, message }));
	}

	const shown = $derived.by(() => {
		const words = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
		return lines.filter((l) => (!onlyErrors || l.level === 'error' || l.level === 'warn') && words.every((w) => l.message.toLowerCase().includes(w)));
	});
	const errorCount = $derived(lines.filter((l) => l.level === 'error').length);

	function pick(s: string) {
		service = s;
		const u = new URL(page.url);
		if (s) u.searchParams.set('service', s);
		else u.searchParams.delete('service');
		history.replaceState(history.state, '', u);
		void load();
	}

	onMount(() => {
		void load();
		const t = setInterval(() => {
			if (live && document.visibilityState === 'visible') void load();
		}, 4000);
		return () => clearInterval(t);
	});
</script>

<svelte:head><title>Logs · {data.project.name} · Forge</title></svelte:head>

{#if !data.running}
	<EmptyState icon={Power} title={data.project.sleepingSince ? 'Projet en veille' : 'Conteneur arrêté'} description={data.project.sleepingSince ? 'Les logs seront disponibles dès que le site sera réveillé (première visite).' : 'Allumez le conteneur pour lire les logs des services.'}>
		<Button href="/projects/{data.project.slug}/container" size="sm" variant="outline">Ressources</Button>
	</EmptyState>
{:else}
	<div class="space-y-3">
		<div class="flex flex-wrap items-center gap-2">
			<div class="flex flex-wrap items-center gap-1 rounded-lg border bg-card p-0.5">
				<button class={cn('rounded-md px-2.5 py-1 text-xs font-medium', service === '' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')} onclick={() => pick('')}>Tous</button>
				{#if !svc.value}<span class="px-2"><Spinner class="size-3" /></span>{/if}
				{#each services as s (s.name)}
					<button class={cn('inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-xs', service === s.service ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')} onclick={() => pick(s.service)}>
						<span class={cn('size-1.5 rounded-full', s.state === 'running' ? 'bg-success' : 'bg-danger')}></span>{s.service}
					</button>
				{/each}
			</div>
			<div class="relative min-w-40 flex-1">
				<Search class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
				<input bind:value={q} placeholder="Filtrer les lignes…" class="h-8 w-full rounded-lg border bg-card pr-2 pl-8 text-xs outline-none focus:border-ember/50 focus:ring-2 focus:ring-ember/20" />
			</div>
			<button
				class={cn('inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium', onlyErrors ? 'border-danger/40 bg-danger/10 text-danger' : 'bg-card text-muted-foreground hover:text-foreground')}
				onclick={() => (onlyErrors = !onlyErrors)}
			>
				Erreurs{#if errorCount}<span class="rounded bg-danger/15 px-1 text-danger tabular-nums">{errorCount}</span>{/if}
			</button>
			<select bind:value={tail} onchange={load} class="h-8 rounded-lg border bg-card px-2 text-xs" aria-label="Nombre de lignes">
				{#each [100, 300, 1000, 3000] as n (n)}<option value={n}>{n} lignes</option>{/each}
			</select>
			<button
				class={cn('inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium', live ? 'border-success/40 bg-success/10 text-success' : 'bg-card text-muted-foreground hover:text-foreground')}
				onclick={() => ((live = !live), live && load())}
				title="Recharger toutes les 4 secondes"
			>
				<Radio class={cn('size-3.5', live && 'animate-pulse')} /> Direct
			</button>
			<Button variant="outline" size="sm" class="h-8" onclick={load} disabled={loading} aria-label="Recharger">
				{#if loading}<Spinner />{:else}<RefreshCw />{/if}
			</Button>
		</div>
		{#if error}<Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>{/if}
		<Terminal logs={shown} raw {live} title="docker compose logs{service ? ` ${service}` : ''} · {shown.length}/{lines.length} lignes" height="calc(100vh - 22rem)" />
		<p class="text-xs text-muted-foreground">
			Lecture seule, les {tail} dernières lignes{loadedAt ? `, chargées à ${new Date(loadedAt).toLocaleTimeString('fr-FR')}` : ''}. Les lignes contenant « error », « exception »… sont en rouge.
		</p>
	</div>
{/if}

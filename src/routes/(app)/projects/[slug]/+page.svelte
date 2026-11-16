<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import { coalesce, onJobChange } from '$lib/live.svelte';
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Hammer from '@lucide/svelte/icons/hammer';
	import HardDrive from '@lucide/svelte/icons/hard-drive';
	import Globe from '@lucide/svelte/icons/globe';
	import Layers from '@lucide/svelte/icons/layers';
	import Moon from '@lucide/svelte/icons/moon';
	import Power from '@lucide/svelte/icons/power';
	import GitCommitHorizontal from '@lucide/svelte/icons/git-commit-horizontal';
	import StatusDot from '$lib/components/atoms/status-dot.svelte';
	import Meter from '$lib/components/atoms/meter.svelte';
	import Spinner from '$lib/components/atoms/spinner.svelte';
	import RelativeTime from '$lib/components/molecules/relative-time.svelte';
	import CopyButton from '$lib/components/molecules/copy-button.svelte';
	import JobList from '$lib/components/organisms/job-list.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import { bytes, percent, uptime } from '$lib/format';
	import { statusInfo, usageTone, TONE_TEXT } from '$lib/status';
	import { cn } from '$lib/utils';
	import { deferred } from '$lib/deferred.svelte';

	let { data } = $props();
	const p = $derived(data.project);
	const base = $derived(`/projects/${p.slug}`);
	const g = $derived(data.guest);
	const running = $derived(g?.status === 'running');
	const svc = deferred(() => data.services);
	const services = $derived(svc.value?.services ?? []);
	const diskRatio = $derived(g?.maxdisk ? g.disk / g.maxdisk : 0);

	const reload = coalesce(() => invalidate('forge:overview'));
	onJobChange((e) => {
		if (e.slug === p.slug) reload();
	});
	onMount(() => {
		const t = setInterval(() => {
			if (document.visibilityState === 'visible') reload();
		}, 20_000);
		return () => clearInterval(t);
	});
</script>

<svelte:head><title>{p.name} · Forge</title></svelte:head>

<div class="space-y-6">
	<!-- Ce qui demande une action sur ce projet -->
	{#if p.sleepingSince}
		<div class="flex items-center gap-3 rounded-xl border border-info/30 bg-info/5 px-4 py-3 text-sm">
			<Moon class="size-4 shrink-0 text-info" />
			<p class="flex-1">En veille depuis <RelativeTime value={p.sleepingSince} /> : le site se réveille tout seul à la première visite (quelques secondes).</p>
			<Button href="{base}/container" variant="outline" size="sm">Réglages de veille</Button>
		</div>
	{/if}
	{#if p.ctid && data.build.buildMode !== 'builder' && data.level === 'admin'}
		<div class="flex items-center gap-3 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm">
			<Hammer class="size-4 shrink-0 text-warning" />
			<p class="flex-1">Ce projet construit encore ses images dans son propre conteneur (runner GitHub). Le passer sur le CT de build libère RAM et disque.</p>
			<Button href="{base}/deployments" variant="outline" size="sm">Migrer <ArrowRight /></Button>
		</div>
	{/if}
	{#if diskRatio >= 0.85}
		<div class="flex items-center gap-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm">
			<HardDrive class="size-4 shrink-0 text-danger" />
			<p class="flex-1">Disque plein à {percent(diskRatio)} : agrandissez-le ou faites le ménage avant le prochain déploiement.</p>
			<Button href="{base}/container" variant="outline" size="sm">Ressources <ArrowRight /></Button>
		</div>
	{/if}

	<div class="grid gap-6 lg:grid-cols-3">
		<div class="space-y-6 lg:col-span-2">
			<!-- Adresses -->
			<section class="rounded-xl border bg-card">
				<div class="flex items-center justify-between border-b px-4 py-3">
					<h2 class="flex items-center gap-2 text-sm font-semibold"><Globe class="size-4 text-muted-foreground" /> Adresses</h2>
					<a href="{base}/domains" class="text-xs text-muted-foreground hover:text-foreground">Gérer →</a>
				</div>
				{#if data.domains.length}
					<ul class="divide-y">
						{#each data.domains as d (d.id)}
							{@const st = statusInfo(d.status)}
							<li class="group flex items-center gap-3 px-4 py-3">
								<StatusDot tone={st.tone} pulse={st.pulse} />
								<a href="https://{d.fqdn}" target="_blank" rel="noreferrer" class="min-w-0 flex-1 truncate font-mono text-sm hover:text-ember">{d.fqdn}</a>
								<span class="text-xs text-muted-foreground">{st.label}</span>
								<CopyButton value="https://{d.fqdn}" />
								<Button href="https://{d.fqdn}" target="_blank" rel="noreferrer" variant="ghost" size="icon" class="size-7" aria-label="Ouvrir"><ArrowUpRight /></Button>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="px-4 py-5 text-sm text-muted-foreground">Aucun domaine : le site n'est pas encore accessible depuis Internet. <a href="{base}/domains" class="text-foreground underline underline-offset-4">Ajouter un domaine</a></p>
				{/if}
			</section>

			<!-- Services -->
			<section class="rounded-xl border bg-card">
				<div class="flex items-center justify-between border-b px-4 py-3">
					<h2 class="flex items-center gap-2 text-sm font-semibold"><Layers class="size-4 text-muted-foreground" /> Services</h2>
					<a href="{base}/logs" class="text-xs text-muted-foreground hover:text-foreground">Voir les logs →</a>
				</div>
				{#if !running}
					<p class="px-4 py-5 text-sm text-muted-foreground">{p.sleepingSince ? 'En veille : les services démarrent à la première visite.' : 'Le conteneur est arrêté.'}</p>
				{:else if !svc.value}
					<p class="flex items-center gap-2 px-4 py-5 text-sm text-muted-foreground"><Spinner /> Lecture des services…</p>
				{:else if svc.value.error && !services.length}
					<p class="px-4 py-5 text-sm text-danger">{svc.value.error}</p>
				{:else if !services.length}
					<p class="px-4 py-5 text-sm text-muted-foreground">Aucun service : le premier déploiement n'a pas encore eu lieu.</p>
				{:else}
					<ul class="divide-y">
						{#each services as s (s.name)}
							{@const ok = s.state === 'running'}
							<li class="flex items-center gap-3 px-4 py-2.5 text-sm">
								<StatusDot tone={ok ? 'success' : 'danger'} />
								<a href="{base}/logs?service={encodeURIComponent(s.service)}" class="font-mono font-medium hover:text-ember">{s.service}</a>
								{#if s.service === data.build.appService}<span class="rounded bg-ember/10 px-1.5 text-[10px] font-medium text-ember">app · :{data.build.appPort}</span>{/if}
								<span class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{s.image}</span>
								<span class={cn('text-xs', ok ? 'text-muted-foreground' : 'text-danger')}>{s.status}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<!-- Derniers jobs -->
			<section class="space-y-3">
				<div class="flex items-center justify-between">
					<h2 class="text-sm font-semibold">Dernière activité</h2>
					<a href="{base}/deployments" class="text-xs text-muted-foreground hover:text-foreground">Tout voir →</a>
				</div>
				<JobList jobs={data.jobs} showProject={false} />
			</section>
		</div>

		<!-- Colonne droite : ressources et fiche technique -->
		<aside class="space-y-6">
			<section class="rounded-xl border bg-card">
				<div class="flex items-center justify-between border-b px-4 py-3">
					<h2 class="flex items-center gap-2 text-sm font-semibold"><Power class={cn('size-4', running ? 'text-success' : 'text-muted-foreground')} /> Conteneur</h2>
					<a href="{base}/container" class="text-xs text-muted-foreground hover:text-foreground">Gérer →</a>
				</div>
				{#if g}
					<div class="space-y-4 p-4">
						<p class="text-xs text-muted-foreground">{running ? `En marche depuis ${uptime(g.uptime)}` : 'Arrêté'} · CT {p.ctid}</p>
						{@render meter('Processeur', running ? percent(g.cpu) : '—', `${g.maxcpu} cœur${g.maxcpu > 1 ? 's' : ''}`, running ? g.cpu : 0)}
						{@render meter('Mémoire', running ? bytes(g.mem) : '—', `sur ${bytes(g.maxmem)}`, running && g.maxmem ? g.mem / g.maxmem : 0)}
						{@render meter('Disque', bytes(g.disk), `sur ${bytes(g.maxdisk)}`, diskRatio)}
					</div>
				{:else}
					<p class="px-4 py-5 text-sm text-muted-foreground">{p.ctid ? 'Conteneur introuvable sur Proxmox.' : "Pas encore de conteneur : il sera créé au premier déploiement."}</p>
				{/if}
			</section>

			<section class="rounded-xl border bg-card p-4">
				<h2 class="mb-3 text-sm font-semibold">Fiche technique</h2>
				<dl class="space-y-2.5 text-sm">
					<div class="flex items-baseline justify-between gap-3">
						<dt class="text-xs text-muted-foreground">Commit en ligne</dt>
						<dd class="flex items-center gap-1 font-mono text-xs">
							{#if data.build.deployedSha}
								<GitCommitHorizontal class="size-3.5 text-muted-foreground" />
								<a href="https://github.com/{p.repoOwner}/{p.repoName}/commit/{data.build.deployedSha}" target="_blank" rel="noreferrer" class="hover:text-ember">{data.build.deployedSha.slice(0, 7)}</a>
							{:else}<span class="font-sans text-muted-foreground">inconnu</span>{/if}
						</dd>
					</div>
					{@render kv('Déploiement auto', data.build.buildMode === 'builder' ? (data.build.autoDeploy ? 'à chaque push' : 'désactivé') : 'runner GitHub')}
					{@render kv('Mode', data.build.deployMode === 'compose' ? 'docker compose' : 'Dockerfile seul')}
					{#if data.build.dbKind}{@render kv('Base de données', data.build.dbKind)}{/if}
					{#if p.ip}{@render kv('Adresse IP', p.ip, true)}{/if}
					{@render kv('Dernière sauvegarde', data.lastBackup ? null : 'aucune', false, data.lastBackup)}
				</dl>
			</section>
		</aside>
	</div>
</div>

{#snippet meter(label: string, value: string, sub: string, ratio: number)}
	<div>
		<div class="mb-1.5 flex items-baseline justify-between text-xs">
			<span class="text-muted-foreground">{label}</span>
			<span><span class={cn('font-medium', TONE_TEXT[usageTone(ratio)])}>{value}</span> <span class="text-muted-foreground">{sub}</span></span>
		</div>
		<Meter value={ratio} />
	</div>
{/snippet}

{#snippet kv(label: string, value: string | null, mono = false, ts: number | null = null)}
	<div class="flex items-baseline justify-between gap-3">
		<dt class="text-xs text-muted-foreground">{label}</dt>
		<dd class={cn('truncate text-right text-xs', mono && 'font-mono')}>
			{#if ts}<RelativeTime value={ts * 1000} />{:else}{value}{/if}
		</dd>
	</div>
{/snippet}

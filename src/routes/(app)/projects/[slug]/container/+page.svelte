<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import WebConsole from '$lib/components/organisms/web-console.svelte';
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import Play from '@lucide/svelte/icons/play';
	import Power from '@lucide/svelte/icons/power';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import Square from '@lucide/svelte/icons/square';
	import Cpu from '@lucide/svelte/icons/cpu';
	import MemoryStick from '@lucide/svelte/icons/memory-stick';
	import HardDrive from '@lucide/svelte/icons/hard-drive';
	import Container from '@lucide/svelte/icons/container';
	import Layers from '@lucide/svelte/icons/layers';
	import Archive from '@lucide/svelte/icons/archive';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { toast } from 'svelte-sonner';
	import { goto } from '$app/navigation';
	import { levelAtLeast } from '$lib/domain/access';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import SectionCard from '$lib/components/molecules/section-card.svelte';
	import StatMeter from '$lib/components/molecules/stat-meter.svelte';
	import StatusBadge from '$lib/components/molecules/status-badge.svelte';
	import KeyValue from '$lib/components/molecules/key-value.svelte';
	import ConfirmDialog from '$lib/components/molecules/confirm-dialog.svelte';
	import RelativeTime from '$lib/components/molecules/relative-time.svelte';
	import EmptyState from '$lib/components/molecules/empty-state.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import * as Alert from '$lib/components/atoms/ui/alert';
	import Spinner from '$lib/components/atoms/spinner.svelte';
	import { bytes, percent, uptime } from '$lib/format';
	import { CUSTOM_LIMITS, effectiveSize, SIZES, type SizeKey } from '$lib/domain/sizes';
	import { untrack } from 'svelte';
	import Gauge from '@lucide/svelte/icons/gauge';
	import { Input } from '$lib/components/atoms/ui/input';
	import { Label } from '$lib/components/atoms/ui/label';
	import { Checkbox } from '$lib/components/atoms/ui/checkbox';
	import { cn } from '$lib/utils';
	import { deferred } from '$lib/deferred.svelte';

	let { data, form } = $props();
	const c = $derived(data.container);
	// docker compose ps (SSH) : arrive après la page, l'ancienne liste reste affichée pendant un rafraîchissement.
	const svc = deferred(() => data.services);
	const services = $derived(svc.value?.services ?? []);
	const g = $derived(c.guest);
	const running = $derived(g?.status === 'running');

	let confirm = $state<{ action: string; title: string; description: string } | null>(null);
	let confirmOpen = $state(false);
	let powerForm: HTMLFormElement | undefined = $state();
	let moving = $state(false);
	let waking = $state(false);
	let powerAction = $state('');
	let backingUp = $state(false);
	let restoreTarget = $state<{ volid: string; ctime: number } | null>(null);
	let restoreForm = $state<HTMLFormElement | null>(null);
	const isAdmin = $derived(data.level === 'admin');
	const canEdit = $derived(data.level === 'admin' || levelAtLeast(data.level, 'edit'));

	function ask(action: string, title: string, description: string) {
		confirm = { action, title, description };
		confirmOpen = true;
	}
	function submitPower(action: string) {
		powerAction = action;
		queueMicrotask(() => powerForm?.requestSubmit());
	}

	/** Jamais deux rafraîchissements en même temps. */
	let inFlight = false;
	onMount(() => {
		const t = setInterval(async () => {
			if (inFlight || document.visibilityState !== 'visible') return;
			inFlight = true;
			try {
				await invalidate('forge:container');
			} finally {
				inFlight = false;
			}
		}, 15_000);
		return () => clearInterval(t);
	});
	const size = $derived(effectiveSize(data.project.size, data.project));
	const currentDiskGb = $derived(Number(/size=(\d+)G/.exec(c.rootfs ?? '')?.[1] ?? size.diskGb));
	const diskRatio = $derived(g?.maxdisk ? g.disk / g.maxdisk : 0);

	// --- Changement de taille ---------------------------------------------------------------
	let preset = $state<SizeKey>(untrack(() => data.project.size));
	let cores = $state(untrack(() => effectiveSize(data.project.size, data.project).cores));
	let memoryMb = $state(untrack(() => effectiveSize(data.project.size, data.project).memoryMb));
	let diskGb = $state(untrack(() => Number(/size=(\d+)G/.exec(data.container.rootfs ?? '')?.[1] ?? effectiveSize(data.project.size, data.project).diskGb)));
	let ackRam = $state(false);
	function pick(k: SizeKey) {
		preset = k;
		cores = SIZES[k].cores;
		memoryMb = SIZES[k].memoryMb;
		diskGb = Math.max(SIZES[k].diskGb, currentDiskGb);
	}
	const sizeChanged = $derived(cores !== size.cores || memoryMb !== size.memoryMb || diskGb !== currentDiskGb);
</script>

<svelte:head><title>Conteneur · {data.project.name} · Forge</title></svelte:head>

<form method="POST" action="?/power" bind:this={powerForm} use:enhance class="hidden"><input type="hidden" name="action" value={powerAction} /></form>

{#if !g}
	<EmptyState icon={Container} title="Pas encore de conteneur" description="Le CT est créé à la première étape du déploiement initial." />
{:else}
	<div class="space-y-6">
		{#if form?.error}<Alert.Root variant="destructive"><Alert.Description>{form.error}</Alert.Description></Alert.Root>{/if}

		<SectionCard title="CT {g.vmid} · {g.name}" description="Pool {g.pool} · taille {data.project.size}{data.project.cores || data.project.memoryMb || data.project.diskGb ? ' personnalisée' : ''} ({size.cores} cœur(s), {size.memoryMb / 1024} Go, {currentDiskGb} Go)" icon={Container}>
			{#snippet actions()}
				<StatusBadge status={g.status} />
				{#if running}
					<form method="POST" action="?/clean" use:enhance class="contents"><Button type="submit" variant="outline" size="sm" disabled={!!data.activeJob} title="Cache de build et images Docker inutilisées (jamais les volumes)">Nettoyer</Button></form>
					<Button variant="outline" size="sm" disabled={!!data.activeJob} onclick={() => ask('reboot', 'Redémarrer le CT ?', "L'application sera indisponible quelques secondes.")}><RotateCw /> Redémarrer</Button>
					<Button variant="outline" size="sm" disabled={!!data.activeJob} onclick={() => ask('shutdown', 'Éteindre le CT ?', "Arrêt propre (60 s max). L'application sera hors ligne.")}><Power /> Éteindre</Button>
					<Button variant="ghost" size="sm" class="text-danger" disabled={!!data.activeJob} onclick={() => ask('stop', 'Forcer l’arrêt du CT ?', 'Arrêt brutal, comme débrancher la prise. Préférez « Éteindre ».')}><Square /> Forcer l'arrêt</Button>
				{:else}
					<Button size="sm" disabled={!!data.activeJob} onclick={() => submitPower('start')}><Play /> Démarrer</Button>
				{/if}
			{/snippet}
			<div class="grid gap-6 sm:grid-cols-3">
				<StatMeter label="CPU" icon={Cpu} value={running ? percent(g.cpu, 1) : '—'} detail="sur {g.maxcpu} cœur(s)" ratio={g.cpu} />
				<StatMeter label="Mémoire" icon={MemoryStick} value={running ? bytes(g.mem) : '—'} detail="sur {bytes(g.maxmem)}" ratio={g.maxmem ? g.mem / g.maxmem : 0} />
				<StatMeter label="Disque" icon={HardDrive} value={bytes(g.disk)} detail="sur {bytes(g.maxdisk)}" ratio={g.maxdisk ? g.disk / g.maxdisk : 0} />
			</div>
			<dl class="mt-5 grid gap-x-8 border-t pt-3 sm:grid-cols-2">
				<KeyValue label="IP" mono>{data.project.ip}</KeyValue>
				<KeyValue label="En marche depuis">{running ? uptime(g.uptime) : '—'}</KeyValue>
				<KeyValue label="Démarrage auto">{c.onboot ? 'Oui' : 'Non'}</KeyValue>
				<KeyValue label="Swap">{c.swap ?? '—'} Mo</KeyValue>
				<KeyValue label="Disque" mono>{c.rootfs ?? '—'}</KeyValue>
				<KeyValue label="Stockage">{data.storage.current ?? '—'}{data.storage.current === data.storage.zfs ? ' (ZFS)' : ''}</KeyValue>
				<KeyValue label="Clé d'hôte SSH" mono>{data.project.sshHostKey ?? 'pas encore vue'}</KeyValue>
			</dl>
		</SectionCard>

		{#if data.sleep}
			{@const z = data.sleep}
			<SectionCard title="Mise en veille" description="Serveur de dev : éteint après un moment sans visiteur, rallumé tout seul au premier visiteur (page « réveil en cours », moins d'une minute). Économise la RAM du serveur." icon={Power}>
				{#if z.sleeping}
					<p class="mb-3 text-sm">💤 Endormi depuis {new Date(z.since ?? 0).toLocaleString('fr-FR')}.{#if z.wakeError} <span class="text-danger">Dernier réveil en échec : {z.wakeError}</span>{/if}</p>
				{:else if z.lastActivity}
					<p class="mb-3 text-sm text-muted-foreground">Dernière visite vue : {new Date(z.lastActivity).toLocaleString('fr-FR')}.</p>
				{/if}
				<div class="flex flex-wrap items-center gap-2">
					<form method="POST" action="?/sleep" use:enhance class="flex items-center gap-2">
						<select name="minutes" class="h-8 rounded-md border bg-background px-2 text-sm" value={z.minutes} onchange={(e) => e.currentTarget.form?.requestSubmit()}>
							{#each z.choices as m (m)}<option value={m}>{m === 0 ? 'Jamais' : m < 60 ? `Après ${m} min sans visite` : `Après ${m / 60} h sans visite`}</option>{/each}
						</select>
					</form>
					{#if z.sleeping}
						<form method="POST" action="?/wake" use:enhance={() => { waking = true; return async ({ update }) => { await update(); waking = false; }; }}>
							<Button type="submit" size="sm" disabled={waking}>{#if waking}<Spinner />{:else}<Play />{/if} Réveiller maintenant</Button>
						</form>
					{/if}
				</div>
			</SectionCard>
		{/if}

		{#if data.storage.canMove}
			<Alert.Root>
				<HardDrive />
				<Alert.Title>Disque sur « {data.storage.current} » : passer sur ZFS ?</Alert.Title>
				<Alert.Description>
					<p>Le stockage ZFS « {data.storage.zfs} » est prêt : disque compressé, place réellement utilisée, sauvegardes plus rapides. Forge éteint le CT, copie le disque, puis le rallume (quelques minutes de coupure).</p>
					<form method="POST" action="?/moveToZfs" use:enhance={() => { moving = true; return async ({ update }) => { await update(); moving = false; }; }} class="mt-2">
						<Button type="submit" size="sm" variant="outline" disabled={!!data.activeJob || moving}>{#if moving}<Spinner />{/if} Passer sur ZFS</Button>
					</form>
				</Alert.Description>
			</Alert.Root>
		{/if}

		{#if diskRatio > 0.8}
			<Alert.Root class="border-warning/40 text-warning">
				<HardDrive />
				<Alert.Title>Disque plein à {Math.round(diskRatio * 100)} %</Alert.Title>
				<Alert.Description class="text-warning/90">
					<p>Agrandissez-le ci-dessous (à chaud, sans redémarrage), ou faites le ménage : cache de build et images Docker inutilisées (les volumes et les images en service ne sont jamais touchés).</p>
					<form method="POST" action="?/clean" use:enhance class="mt-2"><Button type="submit" size="sm" variant="outline" disabled={!!data.activeJob}>Nettoyer le CT</Button></form>
				</Alert.Description>
			</Alert.Root>
		{/if}

		<SectionCard title="Taille" description="RAM et cœurs modifiables à chaud, dans les deux sens. Le disque ne peut qu'être agrandi (Proxmox ne réduit jamais un disque)." icon={Gauge}>
			<form id="resize-form" method="POST" action="?/resize" use:enhance class="space-y-4">
				<input type="hidden" name="preset" value={preset} />
				<div class="flex flex-wrap gap-2">
					{#each Object.values(SIZES) as s (s.key)}
						<Button type="button" size="sm" variant={preset === s.key && cores === s.cores && memoryMb === s.memoryMb ? 'secondary' : 'outline'} onclick={() => pick(s.key)}>
							<span class="font-semibold">{s.key}</span>
							<span class="text-muted-foreground">{s.cores} cœur(s) · {s.memoryMb / 1024} Go · {s.diskGb} Go</span>
						</Button>
					{/each}
				</div>
				<div class="grid gap-4 sm:grid-cols-3">
					<div class="space-y-2">
						<Label for="cores">Cœurs</Label>
						<Input id="cores" name="cores" type="number" min={CUSTOM_LIMITS.cores.min} max={CUSTOM_LIMITS.cores.max} bind:value={cores} class="font-mono" />
					</div>
					<div class="space-y-2">
						<Label for="memoryMb">RAM (Mo)</Label>
						<Input id="memoryMb" name="memoryMb" type="number" min={CUSTOM_LIMITS.memoryMb.min} max={CUSTOM_LIMITS.memoryMb.max} step={128} bind:value={memoryMb} class="font-mono" />
						<p class="text-xs text-muted-foreground">Swap : {Math.round(memoryMb / 2)} Mo.</p>
					</div>
					<div class="space-y-2">
						<Label for="diskGb">Disque (Go)</Label>
						<Input id="diskGb" name="diskGb" type="number" min={currentDiskGb} max={CUSTOM_LIMITS.diskGb.max} bind:value={diskGb} class="font-mono" />
						<p class="text-xs text-muted-foreground">Actuellement {currentDiskGb} Go, {bytes(g.disk)} utilisés.</p>
					</div>
				</div>
				{#if form && 'error' in form && typeof form.error === 'string' && form.error.includes('cochez')}
					<label class="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
						<Checkbox bind:checked={ackRam} name="acknowledgeRam" class="mt-0.5" />
						<span><span class="font-medium text-warning">RAM serrée sur l'hôte</span> — je confirme le changement.</span>
					</label>
				{/if}
			</form>
			{#snippet footer()}
				<p class={cn('text-xs', memoryMb > size.memoryMb ? 'text-warning' : 'text-muted-foreground')}>
					{#if memoryMb !== size.memoryMb}RAM : {size.memoryMb} → {memoryMb} Mo{memoryMb > size.memoryMb ? ' (pris sur l’hôte)' : ''}{/if}
				</p>
				<Button type="submit" form="resize-form" size="sm" disabled={!sizeChanged || !!data.activeJob}><Gauge /> Appliquer</Button>
			{/snippet}
		</SectionCard>

		<SectionCard title="Services Docker" description="docker compose ps — {data.composePath}" icon={Layers} bodyClass="p-0">
			{#snippet actions()}<Button href="/projects/{data.project.slug}/logs" variant="outline" size="sm">Voir les logs</Button>{/snippet}
			{#if !svc.value}
				<p class="flex items-center gap-2 px-5 py-6 text-sm text-muted-foreground"><Spinner /> docker compose ps…</p>
			{:else if svc.value.error}
				<div class="p-4"><Alert.Root variant="destructive"><Alert.Description>{svc.value.error}</Alert.Description></Alert.Root></div>
			{:else if services.length === 0}
				<p class="px-5 py-6 text-sm text-muted-foreground">{running ? 'Aucun service (premier déploiement pas encore exécuté ?)' : 'Le CT est arrêté.'}</p>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full text-sm">
						<thead class="bg-muted/40 text-xs text-muted-foreground">
							<tr>
								<th class="px-5 py-2 text-left font-medium">Service</th>
								<th class="px-3 py-2 text-left font-medium">Conteneur</th>
								<th class="px-3 py-2 text-left font-medium">Image</th>
								<th class="px-3 py-2 text-left font-medium">Ports</th>
								<th class="px-5 py-2 text-right font-medium">État</th>
							</tr>
						</thead>
						<tbody class="divide-y">
							{#each services as s (s.name)}
								<tr>
									<td class="px-5 py-2.5 font-mono font-medium">{s.service}</td>
									<td class="px-3 py-2.5 font-mono text-xs text-muted-foreground">{s.name}</td>
									<td class="px-3 py-2.5 font-mono text-xs text-muted-foreground">{s.image}</td>
									<td class="px-3 py-2.5 font-mono text-xs">{s.ports || '—'}</td>
									<td class="px-5 py-2.5 text-right"><StatusBadge status={s.state} /> <span class="ml-1 text-xs text-muted-foreground">{s.status}</span></td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</SectionCard>


		<SectionCard
			title="Pare-feu Proxmox"
			description="Isole ce CT : seul NPM atteint le port {data.project.appPort}, Forge et l'hôte (Tailscale) gardent l'accès, le reste du bridge (prod comprise) est bloqué."
			icon={data.firewall.status?.upToDate ? ShieldCheck : ShieldAlert}
			bodyClass="p-0"
		>
			{#snippet actions()}
				<form method="POST" action="?/firewall" use:enhance>
					<Button type="submit" size="sm" variant={data.firewall.status?.upToDate ? 'outline' : 'default'} disabled={!!data.activeJob}>
						<ShieldCheck />
						{data.firewall.status?.upToDate ? 'Réappliquer' : 'Appliquer'}
					</Button>
				</form>
			{/snippet}
			<div class="space-y-2 border-b px-4 py-3 text-sm">
				{#if data.firewall.error}
					<p class="text-danger">{data.firewall.error}</p>
				{:else if data.firewall.status?.upToDate}
					<p class="flex items-center gap-1.5 text-success"><ShieldCheck class="size-4" /> Actif et à jour.</p>
				{:else if data.firewall.status?.enabled}
					<p class="flex items-center gap-1.5 text-warning"><ShieldAlert class="size-4" /> Actif, mais les règles Forge diffèrent du plan ci-dessous.</p>
				{:else}
					<p class="flex items-center gap-1.5 text-warning"><ShieldAlert class="size-4" /> Pas de pare-feu sur ce CT : il peut joindre les autres CT du bridge.</p>
				{/if}
				{#if data.firewall.clusterEnabled === false}
					<p class="text-xs text-warning">Le pare-feu du datacenter est désactivé : les règles ne sont pas appliquées tant que <code>infra/05-firewall.sh</code> n'a pas été lancé sur l'hôte.</p>
				{/if}
				{#if !data.firewall.enabledSetting}
					<p class="text-xs text-muted-foreground">Désactivé pour les nouveaux déploiements (Réglages → Réseau) ; le bouton l'applique quand même à ce CT.</p>
				{/if}
			</div>
			<ul class="divide-y font-mono text-xs">
				{#each data.firewall.plan as r, i (i)}
					<li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
						<span class="w-8 text-muted-foreground uppercase">{r.type}</span>
						<span class={r.action === 'ACCEPT' ? 'w-14 text-success' : 'w-14 text-danger'}>{r.action}</span>
						<span class="min-w-0 flex-1">{r.source ? `de ${r.source}` : ''}{r.dest ? `vers ${r.dest}` : ''}{r.proto ? ` · ${r.proto}` : ''}{r.dport ? `/${r.dport}` : ''}</span>
						<span class="font-sans text-muted-foreground">{r.comment.replace(/^forge:\s*/, '')}</span>
					</li>
				{/each}
				<li class="flex items-center gap-3 px-4 py-2 text-muted-foreground"><span class="w-8">IN</span><span class="w-14 text-danger">DROP</span><span class="font-sans">tout le reste (politique par défaut) · anti-usurpation IP</span></li>
			</ul>
		</SectionCard>

		<section id="sauvegardes" class="scroll-mt-20 rounded-lg border bg-card">
			<div class="flex flex-wrap items-center gap-3 border-b px-4 py-3">
				<Archive class="size-4 text-muted-foreground" />
				<div class="min-w-0 flex-1">
					<h2 class="text-[13px] font-semibold">Sauvegardes du conteneur</h2>
					<p class="text-xs text-muted-foreground">Tout le CT (code, images, données). Chaque nuit à {data.backupPlan.schedule} · {data.backupPlan.max} au plus : 7 jours, 4 semaines, 5 mois.</p>
				</div>
				{#if canEdit}
					<form method="POST" action="?/backup" use:enhance={() => { backingUp = true; return async ({ result, update }) => { backingUp = false; if (result.type === 'failure') toast.error((result.data as { error?: string })?.error ?? 'Sauvegarde impossible'); await update(); }; }}>
						<Button type="submit" size="sm" disabled={backingUp || !!data.activeJob || !g}>{#if backingUp}<Spinner />{:else}<Archive />{/if} Sauvegarder maintenant</Button>
					</form>
				{/if}
			</div>
			<div class="grid grid-cols-3 divide-x border-b text-center">
				<div class="px-3 py-3">
					<p class="label-caps text-muted-foreground">Dernière</p>
					<p class="mt-1 text-sm font-medium">{#if c.backups[0]}<RelativeTime value={c.backups[0].ctime * 1000} />{:else}<span class="text-warning">aucune</span>{/if}</p>
				</div>
				<div class="px-3 py-3">
					<p class="label-caps text-muted-foreground">Conservées</p>
					<p class="mt-1 font-mono text-sm font-medium tabular-nums">{c.backups.length}<span class="text-muted-foreground"> / {data.backupPlan.max}</span></p>
				</div>
				<div class="px-3 py-3">
					<p class="label-caps text-muted-foreground">Espace</p>
					<p class="mt-1 font-mono text-sm font-medium tabular-nums">{bytes(c.backups.reduce((a, b) => a + b.size, 0))}</p>
				</div>
			</div>
			{#if c.backups.length === 0}
				<p class="px-4 py-6 text-sm text-muted-foreground">Aucune sauvegarde pour l'instant : la première sera faite cette nuit, ou maintenant avec le bouton.</p>
			{:else}
				<ul class="divide-y text-sm">
					{#each c.backups as b, i (b.volid)}
						<li class="group flex items-center gap-3 px-4 py-2.5">
							<span class={cn('size-1.5 shrink-0 rounded-full', i === 0 ? 'bg-success' : 'bg-muted-foreground/40')}></span>
							<span class="w-40 shrink-0 text-xs">{new Date(b.ctime * 1000).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
							<span class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={b.volid}>{b.volid.split('/').pop()}</span>
							<span class="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{bytes(b.size)}</span>
							{#if isAdmin}
								<Button size="sm" variant="ghost" class="h-7 text-xs opacity-70 group-hover:opacity-100" disabled={!!data.activeJob} onclick={() => (restoreTarget = b)}><RotateCcw /> Restaurer</Button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		{#if isAdmin && running && g}
			<WebConsole slug={data.project.slug} ctid={g.vmid} dryRun={page.data.dryRun === true} />
		{/if}
	</div>
{/if}

<ConfirmDialog
	bind:open={confirmOpen}
	title={confirm?.title ?? ''}
	description={confirm?.description}
	confirmLabel="Confirmer"
	destructive={confirm?.action === 'stop'}
	onConfirm={() => confirm && submitPower(confirm.action)}
/>

<form
	method="POST"
	action="?/restore"
	bind:this={restoreForm}
	class="hidden"
	use:enhance={() => async ({ result }) => {
		if (result.type === 'redirect') void goto(result.location);
		else if (result.type === 'failure') toast.error((result.data as { error?: string })?.error ?? 'Restauration impossible');
	}}
>
	<input type="hidden" name="volid" value={restoreTarget?.volid ?? ''} />
</form>
<ConfirmDialog
	bind:open={() => !!restoreTarget, (v) => { if (!v) restoreTarget = null; }}
	title="Restaurer la sauvegarde du {restoreTarget ? new Date(restoreTarget.ctime * 1000).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }) : ''} ?"
	description="Tout le conteneur revient à cet instant : code, images Docker ET données (base, fichiers envoyés). Ce qui a changé depuis est perdu. Forge fait d'abord une sauvegarde de l'état actuel, puis éteint le CT, le restaure et le rallume (le site est coupé quelques minutes)."
	confirmLabel="Restaurer"
	destructive
	typeToConfirm={data.project.slug}
	onConfirm={() => {
		restoreForm?.requestSubmit();
		restoreTarget = null;
	}}
/>

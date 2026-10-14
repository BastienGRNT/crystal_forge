<script lang="ts">
	import { onMount } from 'svelte';
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
	import ScrollText from '@lucide/svelte/icons/scroll-text';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import SectionCard from '$lib/components/molecules/section-card.svelte';
	import StatMeter from '$lib/components/molecules/stat-meter.svelte';
	import StatusBadge from '$lib/components/molecules/status-badge.svelte';
	import KeyValue from '$lib/components/molecules/key-value.svelte';
	import ConfirmDialog from '$lib/components/molecules/confirm-dialog.svelte';
	import RelativeTime from '$lib/components/molecules/relative-time.svelte';
	import EmptyState from '$lib/components/molecules/empty-state.svelte';
	import Terminal, { type LogLine } from '$lib/components/organisms/terminal.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import * as Select from '$lib/components/atoms/ui/select';
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

	let { data, form } = $props();
	const c = $derived(data.container);
	const g = $derived(c.guest);
	const running = $derived(g?.status === 'running');

	let confirm = $state<{ action: string; title: string; description: string } | null>(null);
	let confirmOpen = $state(false);
	let powerForm: HTMLFormElement | undefined = $state();
	let powerAction = $state('');

	let tail = $state('200');
	let service = $state('');
	let logs = $state<LogLine[]>([]);
	let logsLoading = $state(false);
	let logsError = $state<string | null>(null);

	async function loadLogs() {
		logsLoading = true;
		logsError = null;
		const res = await fetch(`/api/projects/${data.project.slug}/logs?${new URLSearchParams({ tail, service })}`);
		const j = await res.json();
		logsLoading = false;
		if (!res.ok) {
			logsError = j.error;
			return;
		}
		const lines = (j.text as string).split('\n').filter(Boolean);
		logs = lines.map((message, i) => ({ id: i + 1, ts: Date.now(), level: /error|exception|fatal/i.test(message) ? 'error' : /warn/i.test(message) ? 'warn' : 'info', stepKey: null, message }));
	}

	function ask(action: string, title: string, description: string) {
		confirm = { action, title, description };
		confirmOpen = true;
	}
	function submitPower(action: string) {
		powerAction = action;
		queueMicrotask(() => powerForm?.requestSubmit());
	}

	onMount(() => {
		if (running) void loadLogs();
		const t = setInterval(() => void invalidate('forge:container'), 10_000);
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
				<KeyValue label="Clé d'hôte SSH" mono>{data.project.sshHostKey ?? 'pas encore vue'}</KeyValue>
			</dl>
		</SectionCard>

		{#if diskRatio > 0.8}
			<Alert.Root class="border-warning/40 text-warning">
				<HardDrive />
				<Alert.Title>Disque plein à {Math.round(diskRatio * 100)} %</Alert.Title>
				<Alert.Description class="text-warning/90">Agrandissez-le ci-dessous (à chaud, sans redémarrage), ou faites le ménage (images Docker, anciens dumps).</Alert.Description>
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
			{#if c.servicesError}
				<div class="p-4"><Alert.Root variant="destructive"><Alert.Description>{c.servicesError}</Alert.Description></Alert.Root></div>
			{:else if c.services.length === 0}
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
							{#each c.services as s (s.name)}
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

		<SectionCard title="Logs" description="docker compose logs --tail (lecture seule)" icon={ScrollText}>
			{#snippet actions()}
				<Select.Root type="single" bind:value={service}>
					<Select.Trigger size="sm" class="min-w-32">{service || 'Tous les services'}</Select.Trigger>
					<Select.Content>
						<Select.Item value="" label="Tous les services">Tous les services</Select.Item>
						{#each c.services as s (s.service)}<Select.Item value={s.service} label={s.service}>{s.service}</Select.Item>{/each}
					</Select.Content>
				</Select.Root>
				<Select.Root type="single" bind:value={tail}>
					<Select.Trigger size="sm">{tail} lignes</Select.Trigger>
					<Select.Content>
						{#each ['100', '200', '500', '1000'] as n (n)}<Select.Item value={n} label="{n} lignes">{n} lignes</Select.Item>{/each}
					</Select.Content>
				</Select.Root>
				<Button variant="outline" size="sm" onclick={loadLogs} disabled={logsLoading || !running}>
					{#if logsLoading}<Spinner />{:else}<RefreshCw />{/if} Charger
				</Button>
			{/snippet}
			{#if logsError}<Alert.Root variant="destructive" class="mb-3"><Alert.Description>{logsError}</Alert.Description></Alert.Root>{/if}
			<Terminal {logs} raw title="docker compose logs{service ? ` ${service}` : ''}" height="26rem" />
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

		<SectionCard title="Sauvegardes" description="Sauvegardes vzdump de ce CT sur le stockage local (une est faite automatiquement avant toute suppression)." icon={Archive} bodyClass="p-0">
			{#if c.backups.length === 0}
				<p class="px-5 py-6 text-sm text-muted-foreground">Aucune sauvegarde.</p>
			{:else}
				<ul class="divide-y text-sm">
					{#each c.backups as b (b.volid)}
						<li class="flex items-center justify-between gap-3 px-5 py-2.5">
							<span class="truncate font-mono text-xs">{b.volid}</span>
							<span class="shrink-0 text-xs text-muted-foreground">{bytes(b.size)} · <RelativeTime value={b.ctime * 1000} /></span>
						</li>
					{/each}
				</ul>
			{/if}
		</SectionCard>
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

<script lang="ts">
	import DiffView from '$lib/components/molecules/diff-view.svelte';
	import { lineDiff } from '$lib/domain/diff';
	import { onMount } from 'svelte';
	import { enhance, applyAction, deserialize } from '$app/forms';
	import { goto, invalidate } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import Square from '@lucide/svelte/icons/square';
	import GitCommitHorizontal from '@lucide/svelte/icons/git-commit-horizontal';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import Globe from '@lucide/svelte/icons/globe';
	import Boxes from '@lucide/svelte/icons/boxes';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import PackageCheck from '@lucide/svelte/icons/package-check';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import PageHeader from '$lib/components/molecules/page-header.svelte';
	import StatusBadge from '$lib/components/molecules/status-badge.svelte';
	import RelativeTime from '$lib/components/molecules/relative-time.svelte';
	import SectionCard from '$lib/components/molecules/section-card.svelte';
	import CodeBlock from '$lib/components/molecules/code-block.svelte';
	import CopyButton from '$lib/components/molecules/copy-button.svelte';
	import ConfirmDialog from '$lib/components/molecules/confirm-dialog.svelte';
	import Terminal, { type LogLine } from '$lib/components/organisms/terminal.svelte';
	import JobTimeline from '$lib/components/organisms/job-timeline.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import { Badge } from '$lib/components/atoms/ui/badge';
	import * as Alert from '$lib/components/atoms/ui/alert';
	import Spinner from '$lib/components/atoms/spinner.svelte';
	import { duration } from '$lib/format';
	import { RESOURCE_LABEL, resourceDisplay } from '$lib/resources';

	let { data } = $props();

	// Valeurs dérivées des données de la page, puis mises à jour en direct par le flux SSE.
	let job = $derived(data.job);
	let logs = $derived<LogLine[]>(data.logs);
	let filter = $state<string | null>(null);
	let now = $state(Date.now());
	let rollbackOpen = $state(false);
	let busy = $state<string | null>(null);

	const live = $derived(['queued', 'running', 'rolling_back'].includes(job.status));
	const pending = $derived(job.steps.find((s) => s.pendingInput)?.pendingInput ?? null);
	const manualDns = $derived(job.steps.find((s) => s.manualDns?.length && s.status !== 'succeeded')?.manualDns ?? null);
	const failedStep = $derived(job.steps.find((s) => s.status === 'failed'));

	onMount(() => {
		const tick = setInterval(() => (now = Date.now()), 1000);
		let es: EventSource | null = null;
		const connect = () => {
			const after = logs.at(-1)?.id ?? 0;
			es = new EventSource(`/api/jobs/${data.job.id}/events?after=${after}`);
			es.addEventListener('log', (e) => {
				const l = JSON.parse((e as MessageEvent).data) as LogLine;
				if (!logs.some((x) => x.id === l.id)) logs = [...logs, l];
			});
			es.addEventListener('job', (e) => {
				const prev = job.status;
				job = JSON.parse((e as MessageEvent).data);
				if (prev !== job.status) {
					if (job.status === 'succeeded') toast.success(`${job.label} terminé`);
					if (job.status === 'rolled_back') toast.success('Rollback terminé');
					if (job.status === 'failed') toast.error(`${job.label} : échec`, { description: job.error ?? undefined });
					if (job.status === 'awaiting_input') toast.warning('Confirmation requise');
					void invalidate('forge:shell');
				}
			});
		};
		connect();
		return () => {
			clearInterval(tick);
			es?.close();
		};
	});

	async function post(action: string, body: Record<string, string> = {}) {
		busy = action;
		const fd = new FormData();
		for (const [k, v] of Object.entries(body)) fd.set(k, v);
		const res = await fetch(`?/${action}`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
		const result = deserialize(await res.text());
		busy = null;
		if (result.type === 'failure') {
			toast.error((result.data as { error?: string })?.error ?? 'Action impossible');
			return null;
		}
		if (result.type === 'success') return result.data as Record<string, unknown>;
		await applyAction(result);
		return null;
	}

	async function rollback() {
		const r = await post('rollback');
		const id = (r?.result as { rollbackJobId?: number } | undefined)?.rollbackJobId;
		if (id) {
			toast.info('Rollback lancé');
			await goto(`/jobs/${id}`);
		}
	}

	const total = $derived(job.startedAt ? (job.finishedAt ?? now) - job.startedAt : null);
</script>

<svelte:head><title>Job #{job.id} · Forge</title></svelte:head>

<PageHeader title="{job.label} · #{job.id}">
	{#snippet eyebrow()}
		<a href={job.project ? `/projects/${job.project.slug}` : '/jobs'} class="inline-flex items-center gap-1 hover:text-foreground">
			<ArrowLeft class="size-3.5" />
			{job.project?.name ?? 'Jobs'}
		</a>
	{/snippet}
	<div class="flex flex-wrap items-center gap-2 pt-1 text-sm text-muted-foreground">
		<StatusBadge status={job.status} />
		{#if job.dryRun}<Badge variant="outline" class="border-warning/40 text-warning">DRY-RUN</Badge>{/if}
		<span>Créé <RelativeTime value={job.createdAt} /></span>
		{#if total !== null}<span>· durée {duration(total)}</span>{/if}
		{#if job.targetJobId}<span>· annule le <a class="underline underline-offset-2 hover:text-foreground" href="/jobs/{job.targetJobId}">job #{job.targetJobId}</a></span>{/if}
	</div>
	{#snippet actions()}
		{#if job.status === 'running'}
			<Button variant="outline" size="sm" onclick={() => post('interrupt')} disabled={busy !== null}><Square /> Interrompre</Button>
		{/if}
		{#if job.status === 'failed'}
			<Button size="sm" onclick={() => post('resume')} disabled={busy !== null}>
				{#if busy === 'resume'}<Spinner />{:else}<RotateCcw />{/if}
				Reprendre{failedStep ? ` à « ${failedStep.label} »` : ''}
			</Button>
		{/if}
		{#if (job.status === 'failed' || job.status === 'awaiting_input') && job.type !== 'rollback'}
			<Button variant="destructive" size="sm" onclick={() => (rollbackOpen = true)} disabled={busy !== null}><Undo2 /> Annuler & rollback</Button>
		{/if}
	{/snippet}
</PageHeader>

<div class="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
	<div class="space-y-6">
		<SectionCard title="Étapes" bodyClass="p-2">
			<JobTimeline steps={job.steps} selected={filter} onSelect={(k) => (filter = k)} {now} />
		</SectionCard>

		{#if job.resources.length}
			<SectionCard title="Ressources créées" description="Seules ces ressources seront supprimées en cas de rollback." icon={PackageCheck} bodyClass="p-0">
				<ul class="divide-y text-xs">
					{#each job.resources as r (r.type + r.externalId)}
						<li class="flex items-start justify-between gap-3 px-4 py-2.5">
							<span class="text-muted-foreground">{RESOURCE_LABEL[r.type] ?? r.type}</span>
							<span class="min-w-0 text-right font-mono break-all">{resourceDisplay(r)}</span>
						</li>
					{/each}
				</ul>
			</SectionCard>
		{/if}
	</div>

	<div class="min-w-0 space-y-6">
		{#if job.status === 'failed' && job.error}
			<Alert.Root variant="destructive">
				<TriangleAlert />
				<Alert.Title>Échec{failedStep ? ` à l'étape « ${failedStep.label} »` : ''}</Alert.Title>
				<Alert.Description class="break-words whitespace-pre-line">{job.error}</Alert.Description>
			</Alert.Root>
		{/if}

		{#if job.status === 'awaiting_input' && pending?.kind === 'workflow'}
			<SectionCard title={pending.title} description="Forge va commiter ce fichier sur la branche par défaut. Il ne sera plus jamais réécrit par Forge." icon={GitCommitHorizontal} class="border-warning/40">
				<div class="space-y-4">
					{#each (pending.payload.warnings as string[]) ?? [] as w, i (i)}
						<Alert.Root class="border-warning/40 text-warning">
							<ShieldAlert />
							<Alert.Title>Risque de double déploiement</Alert.Title>
							<Alert.Description class="text-warning/90">{w}</Alert.Description>
						</Alert.Root>
					{/each}
					<CodeBlock code={pending.payload.content as string} title={pending.payload.path as string} />
				</div>
				{#snippet footer()}
					<Button variant="ghost" size="sm" onclick={() => (rollbackOpen = true)}>Annuler le déploiement</Button>
					<form method="POST" action="?/confirm" use:enhance={() => {
						busy = 'confirm';
						return async ({ update }) => {
							await update();
							busy = null;
						};
					}}>
						<input type="hidden" name="key" value="workflow" />
						<Button type="submit" size="sm" disabled={busy !== null}>
							{#if busy === 'confirm'}<Spinner />{:else}<GitCommitHorizontal />{/if}
							Commiter le workflow
						</Button>
					</form>
				{/snippet}
			</SectionCard>
		{/if}

		{#if job.status === 'awaiting_input' && pending?.kind === 'workflow_update'}
			<SectionCard title={pending.title} description="Seules les lignes en couleur changent. Le commit est marqué [skip ci] : il ne déclenche pas de déploiement." icon={GitCommitHorizontal} class="border-warning/40">
				<DiffView lines={lineDiff(pending.payload.before as string, pending.payload.content as string)} title={pending.payload.path as string} />
				{#snippet footer()}
					<form method="POST" action="?/confirm" use:enhance={() => {
						busy = 'confirm';
						return async ({ update }) => {
							await update();
							busy = null;
						};
					}}>
						<input type="hidden" name="key" value="workflow_update" />
						<Button type="submit" size="sm" disabled={busy !== null}>
							{#if busy === 'confirm'}<Spinner />{:else}<GitCommitHorizontal />{/if}
							Commiter la mise à niveau
						</Button>
					</form>
				{/snippet}
			</SectionCard>
		{/if}

		{#if manualDns && job.status === 'running'}
			<SectionCard title="Enregistrement DNS à créer à la main" description="Domaine hors OVH : créez cet enregistrement chez votre registrar. Forge attend qu'il soit visible publiquement." icon={Globe}>
				<div class="space-y-2">
					{#each manualDns as m (m.fqdn)}
						<div class="flex items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2 font-mono text-sm">
							<Badge variant="secondary">A</Badge>
							<span class="truncate">{m.fqdn}</span>
							<span class="text-muted-foreground">→</span>
							<span>{m.ip}</span>
							<span class="ml-auto"><CopyButton value={m.ip} size="icon-xs" /></span>
						</div>
					{/each}
					<p class="text-xs text-muted-foreground">Uniquement un enregistrement A (pas d'AAAA : le 80/443 n'est redirigé qu'en IPv4).</p>
				</div>
			</SectionCard>
		{/if}

		<Terminal {logs} {filter} {live} title={filter ? `Journal · ${job.steps.find((s) => s.key === filter)?.label}` : `job-${job.id}.log`} />
		{#if filter}
			<div class="-mt-3 text-right">
				<Button variant="link" size="sm" onclick={() => (filter = null)}><Boxes /> Afficher toutes les étapes</Button>
			</div>
		{/if}
	</div>
</div>

<ConfirmDialog
	bind:open={rollbackOpen}
	title="Annuler ce job et faire le rollback ?"
	description="Forge supprimera uniquement les ressources créées par ce job (liste ci-dessous), CT compris. Rien d'autre n'est touché."
	confirmLabel="Annuler et supprimer"
	destructive
	onConfirm={rollback}
>
	{#if job.resources.length}
		<ul class="max-h-52 space-y-1 overflow-auto rounded-lg border bg-muted/40 p-3 text-xs">
			{#each job.resources as r (r.type + r.externalId)}
				<li class="flex justify-between gap-3"><span class="text-muted-foreground">{RESOURCE_LABEL[r.type] ?? r.type}</span><span class="font-mono">{resourceDisplay(r)}</span></li>
			{/each}
		</ul>
	{:else}
		<p class="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">Aucune ressource externe n'a été créée par ce job.</p>
	{/if}
</ConfirmDialog>

<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import Database from '@lucide/svelte/icons/database';
	import Table2 from '@lucide/svelte/icons/table-2';
	import Play from '@lucide/svelte/icons/play';
	import Archive from '@lucide/svelte/icons/archive';
	import Download from '@lucide/svelte/icons/download';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Pencil from '@lucide/svelte/icons/pencil';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Plug from '@lucide/svelte/icons/plug';
	import Upload from '@lucide/svelte/icons/upload';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import SectionCard from '$lib/components/molecules/section-card.svelte';
	import KeyValue from '$lib/components/molecules/key-value.svelte';
	import EmptyState from '$lib/components/molecules/empty-state.svelte';
	import RelativeTime from '$lib/components/molecules/relative-time.svelte';
	import CodeBlock from '$lib/components/molecules/code-block.svelte';
	import ConfirmDialog from '$lib/components/molecules/confirm-dialog.svelte';
	import QueryResult from '$lib/components/organisms/query-result.svelte';
	import { Button, buttonVariants } from '$lib/components/atoms/ui/button';
	import { Textarea } from '$lib/components/atoms/ui/textarea';
	import { Switch } from '$lib/components/atoms/ui/switch';
	import { Checkbox } from '$lib/components/atoms/ui/checkbox';
	import { Badge } from '$lib/components/atoms/ui/badge';
	import * as Select from '$lib/components/atoms/ui/select';
	import * as Alert from '$lib/components/atoms/ui/alert';
	import Spinner from '$lib/components/atoms/spinner.svelte';
	import { DB_LABEL, isSqlDbKind, type DbKind } from '$lib/domain/compose-analysis';
	import { bytes, duration } from '$lib/format';
	import { cn } from '$lib/utils';

	let { data, form } = $props();
	const p = $derived(data.project);
	const PAGE = 100;

	// --- Choix de la base ---------------------------------------------------------------
	let chosen = $state('');
	const sqlCandidates = $derived((data.candidates.value ?? []).filter((c) => isSqlDbKind(c.kind)));
	$effect(() => {
		if (!chosen && sqlCandidates[0]) chosen = sqlCandidates[0].service;
	});

	// --- Navigation dans les tables -----------------------------------------------------
	let view = $state<'data' | 'sql'>('data');
	let selected = $state<{ schema: string; name: string; rows: number } | null>(null);
	let page = $state(0);
	let browsing = $state(false);
	let browseError = $state<string | null>(null);
	let browse = $state<{ columns: string[]; rows: string[][] } | null>(null);

	async function open(t: { schema: string; name: string; rows: number }, pageNo = 0) {
		selected = t;
		page = pageNo;
		view = 'data';
		browsing = true;
		browseError = null;
		const res = await fetch(`/api/projects/${p.slug}/db/browse?${new URLSearchParams({ schema: t.schema, table: t.name, page: String(pageNo) })}`);
		const j = await res.json();
		browsing = false;
		if (!res.ok) {
			browseError = j.error;
			browse = null;
		} else browse = j;
	}

	// --- Console SQL ----------------------------------------------------------------------
	let sql = $state('');
	let write = $state(false);
	let confirmDestructive = $state(false);
	let running = $state(false);
	let queryForm = $state<HTMLFormElement | null>(null);
	$effect(() => {
		if (form && 'sql' in form && typeof form.sql === 'string' && !sql) sql = form.sql;
	});
	const result = $derived(form && 'result' in form ? form.result : null);
	const queryError = $derived(form && 'queryError' in form ? form.queryError : null);
	const needsConfirm = $derived(!!(form && 'needsConfirm' in form && form.needsConfirm));

	function sample(t: { schema: string; name: string }) {
		const q = data.info?.value?.kind === 'postgres' ? `"${t.schema}"."${t.name}"` : `\`${t.name}\``;
		sql = `SELECT *\nFROM ${q}\nLIMIT 50;`;
		view = 'sql';
	}

	// --- Sauvegardes -------------------------------------------------------------------------
	let importing = $state(false);
	let restoreName = $state<string | null>(null);
	let restoreOpen = $state(false);
	let restoreForm = $state<HTMLFormElement | null>(null);
	let restoreConfirm = $state('');
	const reasonLabel: Record<string, string> = { import: 'Importée', manual: 'Manuelle', 'pre-deploy': 'Avant déploiement', 'pre-restore': 'Avant restauration', 'pre-query': 'Avant requête' };

	const info = $derived(data.info?.value ?? null);
	const tunnel = $derived(
		info && info.containerIp && p.ip ? `ssh -N -L 1${info.port}:${info.containerIp}:${info.port} root@${p.ip}` : null
	);
</script>

<svelte:head><title>Base de données · {p.name} · Forge</title></svelte:head>

{#if form && 'error' in form && form.error}
	<Alert.Root variant="destructive" class="mb-6"><Alert.Description>{form.error}</Alert.Description></Alert.Root>
{/if}

{#if !data.configured}
	<SectionCard title="Base de données" description="Forge sauvegarde la base avant chaque déploiement et vous donne une console SQL, sans exposer de port." icon={Database}>
		{#if data.candidates.error}
			<Alert.Root variant="destructive"><Alert.Description>Lecture du compose impossible : {data.candidates.error}</Alert.Description></Alert.Root>
		{:else if sqlCandidates.length === 0}
			<EmptyState icon={Database} title="Aucune base détectée" description="Le docker-compose ne contient pas de service PostgreSQL, MySQL ou MariaDB." />
		{:else}
			<form method="POST" action="?/configure" use:enhance class="flex flex-col gap-3 sm:flex-row sm:items-end">
				<input type="hidden" name="service" value={chosen} />
				<div class="space-y-2">
					<p class="text-sm">Service à gérer</p>
					<Select.Root type="single" bind:value={chosen}>
						<Select.Trigger class="w-72">{#if chosen}{DB_LABEL[(sqlCandidates.find((c) => c.service === chosen)?.kind ?? 'postgres') as DbKind]} · <span class="font-mono">{chosen}</span>{/if}</Select.Trigger>
						<Select.Content>
							{#each sqlCandidates as c (c.service)}<Select.Item value={c.service} label={c.service}>{DB_LABEL[c.kind]} · <span class="font-mono">{c.service}</span></Select.Item>{/each}
						</Select.Content>
					</Select.Root>
				</div>
				<Button type="submit" disabled={!chosen || !!data.activeJob}><Database /> Activer</Button>
			</form>
			<p class="mt-3 text-xs text-muted-foreground">Met à jour les variables FORGE_DB_SERVICE / FORGE_DB_KIND du dépôt. La sauvegarde avant déploiement n'existe que dans les workflows générés par cette version de Forge.</p>
		{/if}
	</SectionCard>
{:else}
	<div class="space-y-6">
		<!-- Informations -->
		<SectionCard title={info ? `${DB_LABEL[info.kind]} ${info.version ?? ''}` : 'Base de données'} description={info ? `Service « ${info.service} » du compose, joint par SSH via docker compose exec.` : undefined} icon={Database}>
			{#snippet actions()}
				<Button variant="ghost" size="sm" onclick={() => invalidate('forge:database')}><RefreshCw /> Actualiser</Button>
			{/snippet}
			{#if data.info?.error}
				<Alert.Root variant="destructive"><TriangleAlert /><Alert.Description>{data.info.error}</Alert.Description></Alert.Root>
			{:else if info}
				<div class="grid gap-x-8 md:grid-cols-2">
					<dl class="divide-y">
						<KeyValue label="Base" mono>{info.database ?? '—'}</KeyValue>
						<KeyValue label="Utilisateur" mono>{info.user ?? '—'}</KeyValue>
						<KeyValue label="Taille">{bytes(info.bytes)}</KeyValue>
					</dl>
					<dl class="divide-y">
						<KeyValue label="Conteneur">
							<Badge variant={info.state === 'running' ? 'secondary' : 'destructive'}>{info.state ?? 'inconnu'}</Badge>
						</KeyValue>
						<KeyValue label="IP interne" mono>{info.containerIp ?? '—'}:{info.port}</KeyValue>
						<KeyValue label="Mot de passe">{#if info.passwordVar}variable <code class="rounded bg-muted px-1">{info.passwordVar}</code> (onglet Variables){:else}—{/if}</KeyValue>
					</dl>
				</div>
				{#if tunnel}
					<details class="group mt-4 rounded-lg border p-3 text-sm">
						<summary class="flex cursor-pointer list-none items-center gap-2 font-medium">
							<Plug class="size-4 text-muted-foreground" /> Se connecter depuis DataGrip / pgAdmin
							<ChevronRight class="ml-auto size-4 transition-transform group-open:rotate-90" />
						</summary>
						<div class="mt-3 space-y-3">
							<p class="text-muted-foreground">
								La base n'expose aucun port. Ouvrez un tunnel SSH vers le CT (via Tailscale), puis connectez-vous à <code>localhost:1{info.port}</code>, base <code>{info.database}</code>, utilisateur <code>{info.envUser ?? info.user}</code>.
								Le CT n'accepte que la clé de Forge : ajoutez la vôtre à <code>/root/.ssh/authorized_keys</code> du CT, ou utilisez l'onglet « SSH tunnel » de DataGrip avec la même commande.
							</p>
							<CodeBlock title="Tunnel SSH" code={tunnel} />
						</div>
					</details>
				{/if}
			{/if}
		</SectionCard>

		<!-- Tables + données / console -->
		<div class="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
			<SectionCard title="Tables" icon={Table2} bodyClass="p-0">
				{#if data.tables?.error}
					<p class="p-4 text-sm text-danger">{data.tables.error}</p>
				{:else}
					<ul class="scrollbar-thin max-h-[32rem] divide-y overflow-auto text-sm">
						{#each data.tables?.value ?? [] as t (`${t.schema}.${t.name}`)}
							<li>
								<button
									type="button"
									class={cn('flex w-full min-w-0 items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted/50', selected?.name === t.name && selected.schema === t.schema && view === 'data' && 'bg-muted')}
									onclick={() => open(t)}
									ondblclick={() => sample(t)}
								>
									<span class="min-w-0 truncate font-mono text-[13px]">{#if t.schema !== 'public'}<span class="text-muted-foreground">{t.schema}.</span>{/if}{t.name}</span>
									<span class="shrink-0 text-xs text-muted-foreground tabular-nums">{t.rows.toLocaleString('fr-FR')}</span>
								</button>
							</li>
						{:else}
							<li class="px-3 py-6 text-center text-xs text-muted-foreground">Aucune table.</li>
						{/each}
					</ul>
				{/if}
			</SectionCard>

			<div class="min-w-0 space-y-3">
				<div class="flex items-center gap-1 rounded-lg border p-0.5 sm:w-fit">
					<Button variant={view === 'data' ? 'secondary' : 'ghost'} size="xs" onclick={() => (view = 'data')}><Table2 /> Données</Button>
					<Button variant={view === 'sql' ? 'secondary' : 'ghost'} size="xs" onclick={() => (view = 'sql')}><Play /> Console SQL</Button>
				</div>

				{#if view === 'data'}
					{#if !selected}
						<EmptyState icon={Table2} title="Choisissez une table" description="Clic : afficher les lignes · double-clic : ouvrir une requête dans la console." />
					{:else}
						<div class="flex flex-wrap items-center justify-between gap-2">
							<p class="font-mono text-sm">{selected.schema}.{selected.name} <span class="text-muted-foreground">· ~{selected.rows.toLocaleString('fr-FR')} lignes</span></p>
							<div class="flex items-center gap-1">
								<Button variant="outline" size="icon-sm" disabled={page === 0 || browsing} onclick={() => selected && open(selected, page - 1)}><ChevronLeft /></Button>
								<span class="px-2 text-xs text-muted-foreground tabular-nums">{page * PAGE + 1}–{page * PAGE + (browse?.rows.length ?? 0)}</span>
								<Button variant="outline" size="icon-sm" disabled={(browse?.rows.length ?? 0) < PAGE || browsing} onclick={() => selected && open(selected, page + 1)}><ChevronRight /></Button>
								<Button variant="ghost" size="sm" onclick={() => selected && sample(selected)}><Pencil /> SQL</Button>
							</div>
						</div>
						{#if browsing}
							<p class="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Spinner /> Lecture…</p>
						{:else if browseError}
							<Alert.Root variant="destructive"><Alert.Description>{browseError}</Alert.Description></Alert.Root>
						{:else if browse}
							<QueryResult columns={browse.columns} rows={browse.rows} />
						{/if}
					{/if}
				{:else}
					<form
						bind:this={queryForm}
						method="POST"
						action="?/query"
						use:enhance={() => {
							running = true;
							return async ({ update }) => {
								await update({ reset: false, invalidateAll: write });
								running = false;
								confirmDestructive = false;
							};
						}}
						class="space-y-3"
					>
						<Textarea
							name="sql"
							bind:value={sql}
							rows={6}
							spellcheck={false}
							placeholder="SELECT * FROM notes ORDER BY id DESC LIMIT 20;"
							class="font-mono text-[13px]"
							onkeydown={(e) => {
								if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
									e.preventDefault();
									queryForm?.requestSubmit();
								}
							}}
						/>
						<div class="flex flex-wrap items-center justify-between gap-3">
							<label class={cn('flex items-center gap-2 text-sm', write && 'text-warning')}>
								<Switch bind:checked={write} name="write" />
								{#if write}<Pencil class="size-3.5" /> Écriture autorisée{:else}<ShieldCheck class="size-3.5 text-success" /> Lecture seule{/if}
							</label>
							<div class="flex items-center gap-3">
								<span class="hidden text-xs text-muted-foreground sm:inline">Ctrl + Entrée</span>
								<Button type="submit" size="sm" disabled={!sql.trim() || running} class={cn(write && 'bg-warning text-black hover:bg-warning/90')}>
									{#if running}<Spinner />{:else}<Play />{/if}
									Exécuter
								</Button>
							</div>
						</div>
						{#if write}
							<p class="text-xs text-muted-foreground">
								Les écritures passent par le garde de sécurité (journalisées, simulées en DRY-RUN). DROP, TRUNCATE, DELETE / UPDATE sans WHERE demandent une confirmation et déclenchent une sauvegarde juste avant.
							</p>
						{/if}
						{#if needsConfirm}
							<label class="flex items-start gap-3 rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm">
								<Checkbox bind:checked={confirmDestructive} name="confirmDestructive" class="mt-0.5" />
								<span><span class="font-medium text-danger">Opération destructrice.</span> Je confirme : Forge sauvegarde la base puis exécute la requête.</span>
							</label>
						{/if}
					</form>

					{#if queryError}
						<Alert.Root variant="destructive"><Alert.Description class="font-mono text-xs whitespace-pre-wrap">{queryError}</Alert.Description></Alert.Root>
					{:else if result}
						<div class="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
							<span>{result.rows.length} ligne(s) · {duration(result.ms)}</span>
							{#if result.truncated}<span class="text-warning">Résultat tronqué à 2 Mo : ajoutez un LIMIT.</span>{/if}
							{#if result.backup}<span class="text-success">Sauvegarde prise avant : {result.backup}</span>{/if}
							{#if result.message}<span>{result.message}</span>{/if}
						</div>
						{#if result.columns.length}<QueryResult columns={result.columns} rows={result.rows} />{/if}
					{/if}
				{/if}
			</div>
		</div>

		<!-- Sauvegardes -->
		<SectionCard
			title="Sauvegardes SQL"
			description="Dumps gzip sur le CT, dans /home/github/forge-backups/{p.slug}. Les 10 dernières « avant déploiement » sont conservées par le workflow."
			icon={Archive}
			bodyClass="p-0"
		>
			{#snippet actions()}
				<form method="POST" action="?/backup" use:enhance>
					<Button type="submit" size="sm" variant="outline" disabled={!!data.activeJob}><Archive /> Sauvegarder maintenant</Button>
				</form>
			{/snippet}
			<form
				method="POST"
				action="?/import"
				enctype="multipart/form-data"
				use:enhance={() => {
					importing = true;
					return async ({ update }) => {
						await update();
						importing = false;
					};
				}}
				class="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center"
			>
				<div class="min-w-0 flex-1 text-sm">
					<p class="font-medium">Importer un dump</p>
					<p class="text-xs text-muted-foreground">.sql ou .sql.gz (100 Mo max), par exemple depuis l'ancien CT d'une app migrée. Il est ajouté à la liste, puis vous le restaurez. Plus gros : <code>infra/06-migrate-db.sh</code>.</p>
				</div>
				<input name="file" type="file" accept=".sql,.gz,.sql.gz" required class="text-xs file:mr-3 file:rounded-md file:border file:bg-muted file:px-2.5 file:py-1 file:text-xs file:text-foreground" />
				<Button type="submit" size="sm" variant="secondary" disabled={importing}>{#if importing}<Spinner />{:else}<Upload />{/if} Importer</Button>
			</form>
			{#if form && 'imported' in form && form.imported}
				<p class="border-b bg-success/5 px-4 py-2 text-sm text-success">
					{form.imported.simulated ? '[DRY-RUN] Import simulé' : `Importé : ${form.imported.name}`} — cliquez sur <RotateCcw class="inline size-3.5" /> pour le restaurer.
				</p>
			{/if}
			{#if data.backups?.error}
				<p class="p-4 text-sm text-danger">{data.backups.error}</p>
			{:else}
				<ul class="divide-y text-sm">
					{#each data.backups?.value ?? [] as b (b.name)}
						<li class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
							<span class="min-w-0 flex-1 truncate font-mono text-[13px]">{b.name}</span>
							<Badge variant="outline">{reasonLabel[b.reason] ?? b.reason}</Badge>
							<span class="w-16 text-right text-xs text-muted-foreground tabular-nums">{bytes(b.size)}</span>
							<span class="w-28 text-xs text-muted-foreground"><RelativeTime value={b.at} /></span>
							<div class="flex gap-1">
								<a href="/api/projects/{p.slug}/db/backups/{b.name}" class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })} title="Télécharger" download><Download /></a>
								<Button
									variant="ghost"
									size="icon-sm"
									title="Restaurer"
									disabled={!!data.activeJob}
									onclick={() => {
										restoreName = b.name;
										restoreOpen = true;
									}}><RotateCcw /></Button
								>
							</div>
						</li>
					{:else}
						<li class="px-4 py-8 text-center text-sm text-muted-foreground">Aucune sauvegarde pour l'instant.</li>
					{/each}
				</ul>
			{/if}
		</SectionCard>
	</div>

	<form bind:this={restoreForm} method="POST" action="?/restore" use:enhance class="hidden">
		<input type="hidden" name="name" value={restoreName ?? ''} />
		<input type="hidden" name="confirm" value={restoreConfirm} />
	</form>
	<ConfirmDialog
		bind:open={restoreOpen}
		title="Restaurer {restoreName}"
		description="Les tables de la base « {p.dbService} » seront remplacées par le contenu de cette sauvegarde. L'état actuel est sauvegardé juste avant (« Avant restauration »)."
		confirmLabel="Restaurer"
		destructive
		typeToConfirm={p.slug}
		onConfirm={() => {
			restoreConfirm = p.slug;
			setTimeout(() => restoreForm?.requestSubmit());
		}}
	/>
{/if}

<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import Rocket from '@lucide/svelte/icons/rocket';
	import FolderGit2 from '@lucide/svelte/icons/folder-git-2';
	import Globe from '@lucide/svelte/icons/globe';
	import Settings2 from '@lucide/svelte/icons/settings-2';
	import Server from '@lucide/svelte/icons/server';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import Info from '@lucide/svelte/icons/info';
	import FileCode from '@lucide/svelte/icons/file-code';
	import PageHeader from '$lib/components/molecules/page-header.svelte';
	import SectionCard from '$lib/components/molecules/section-card.svelte';
	import KeyValue from '$lib/components/molecules/key-value.svelte';
	import RepoPicker from '$lib/components/organisms/repo-picker.svelte';
	import DomainEditor, { type DomainRow } from '$lib/components/organisms/domain-editor.svelte';
	import SizePicker from '$lib/components/organisms/size-picker.svelte';
	import EnvEditor from '$lib/components/organisms/env-editor.svelte';
	import EnvTemplatePanel from '$lib/components/organisms/env-template-panel.svelte';
	import CodeBlock from '$lib/components/molecules/code-block.svelte';
	import Database from '@lucide/svelte/icons/database';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { checkEnvAgainst } from '$lib/domain/env-template';
	import { DB_LABEL, isSqlDbKind, migrationSnippet } from '$lib/domain/compose-analysis';
	import { Button } from '$lib/components/atoms/ui/button';
	import { Input } from '$lib/components/atoms/ui/input';
	import { Label } from '$lib/components/atoms/ui/label';
	import { Checkbox } from '$lib/components/atoms/ui/checkbox';
	import { Badge } from '$lib/components/atoms/ui/badge';
	import * as Select from '$lib/components/atoms/ui/select';
	import * as Alert from '$lib/components/atoms/ui/alert';
	import Spinner from '$lib/components/atoms/spinner.svelte';
	import { slugify, isValidSlug } from '$lib/domain/slug';
	import { buildFqdn } from '$lib/domain/domain-name';
	import { assessHostRam, SIZES, type SizeKey } from '$lib/domain/sizes';
	import { hasEnvErrors, parseEnv } from '$lib/domain/env-file';
	import type { GhRepo } from '$server/application/ports';
	import type { RepoInspection } from '$server/application/use-cases/wizard';
	import { cn } from '$lib/utils';

	let { data, form } = $props();

	let repo = $state('');
	let inspection = $state<RepoInspection | null>(null);
	let inspecting = $state(false);
	let inspectError = $state<string | null>(null);
	let workdir = $state('.');
	let name = $state('');
	let slug = $state('');
	let slugTouched = $state(false);
	let domains = $state<DomainRow[]>(untrack(() => [{ id: 1, subdomain: '', zone: data.zones[0] ?? '', custom: data.zones.length === 0 }]));
	let appPort = $state(3000);
	let appService = $state('app');
	let postDeploy = $state('');
	let size = $state<SizeKey>('M');
	let env = $state('');
	let ackRam = $state(false);
	let ackEnv = $state(false);
	let dbService = $state('');
	let submitting = $state(false);
	let preview = $state<{ ctid: number | null; ip: string | null; freeIps: number; ram: { freeMb: number }; memTotalMb: number } | null>(null);

	async function inspect(full: string, dir: string) {
		inspecting = true;
		inspectError = null;
		const res = await fetch(`/api/github/inspect?${new URLSearchParams({ repo: full, workdir: dir })}`);
		const j = await res.json();
		inspecting = false;
		if (!res.ok) {
			inspectError = j.error;
			inspection = null;
			return;
		}
		inspection = j as RepoInspection;
		const runnable = inspection.compose?.services.filter((x) => !x.db && !inspection?.compose?.migrationServices.some((m) => m.service === x.name)).map((x) => x.name) ?? inspection.composeServices;
		if (inspection.composeServices.length && !inspection.composeServices.includes(appService)) {
			appService = runnable.includes('app') ? 'app' : (runnable[0] ?? inspection.composeServices[0] ?? 'app');
		}
		// Base à sauvegarder avant chaque déploiement : la première base SQL du compose.
		dbService = inspection.compose?.databases.find((d) => isSqlDbKind(d.kind))?.service ?? '';
		// Port publié par le service principal (« 8080:8080 » → 8080).
		const ports = inspection.compose?.services.find((x) => x.name === appService)?.ports ?? [];
		const published = Number(/^(?:[\d.]+:)?(\d+):\d+/.exec(ports[0] ?? '')?.[1]);
		if (published > 0 && published < 65536) appPort = published;
	}

	function onRepo(r: GhRepo) {
		workdir = '.';
		name = r.name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
		if (!slugTouched) slug = slugify(r.name);
		if (!domains[0]?.subdomain) domains[0] = { ...(domains[0] as DomainRow), subdomain: slugify(r.name).replace(/^crystal-?/, '') || slugify(r.name) };
		void inspect(r.fullName, '.');
	}

	$effect(() => {
		const s = size;
		void fetch(`/api/wizard/preview?size=${s}`)
			.then((r) => r.json())
			.then((j) => {
				if (!j.error) preview = j;
			});
	});

	const ram = $derived(preview ? assessHostRam(preview.memTotalMb, preview.memTotalMb - preview.ram.freeMb, SIZES[size]) : null);
	const envParsed = $derived(parseEnv(env));
	const slugOk = $derived(isValidSlug(slug));
	const domainsOk = $derived(domains.length > 0 && domains.every((d) => d.zone.trim() !== ''));
	const firstFqdn = $derived(domains[0]?.zone ? buildFqdn(domains[0].subdomain, domains[0].zone) : null);
	const envCheck = $derived(checkEnvAgainst(env, inspection?.envTemplate ?? null, inspection?.compose?.envRefs ?? []));
	const envUnresolved = $derived(envCheck.unfilled.length + envCheck.missing.filter((m) => m.from === 'compose').length);
	const sqlDbs = $derived(inspection?.compose?.databases.filter((d) => isSqlDbKind(d.kind)) ?? []);
	const migrations = $derived(inspection?.compose?.migrationServices ?? []);
	const canSubmit = $derived(
		!!inspection?.detection.supported &&
			!inspection.linkedProject &&
			slugOk &&
			domainsOk &&
			!hasEnvErrors(envParsed) &&
			(envUnresolved === 0 || ackEnv) &&
			ram?.level !== 'insufficient' &&
			(ram?.level !== 'tight' || ackRam) &&
			!submitting
	);
	const domainsJson = $derived(JSON.stringify(domains.map((d) => ({ subdomain: d.subdomain, zone: d.zone, managed: !d.custom }))));
</script>

<svelte:head><title>Nouveau projet · Forge</title></svelte:head>

<PageHeader title="Nouveau projet" description="Un dépôt GitHub → un conteneur LXC dédié, un runner self-hosted, un proxy NPM avec HTTPS et les DNS OVH." />

<form
	method="POST"
	use:enhance={() => {
		submitting = true;
		return async ({ update }) => {
			await update({ reset: false });
			submitting = false;
		};
	}}
	class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]"
>
	<input type="hidden" name="repo" value={repo} />
	<input type="hidden" name="workdir" value={workdir} />
	<input type="hidden" name="domains" value={domainsJson} />
	<input type="hidden" name="size" value={size} />
	<input type="hidden" name="appService" value={appService} />
	<input type="hidden" name="dbService" value={dbService} />

	<div class="min-w-0 space-y-6">
		{#if form?.error}
			<Alert.Root variant="destructive">
				<CircleX />
				<Alert.Title>Impossible de créer le projet</Alert.Title>
				<Alert.Description class="whitespace-pre-line">{form.error}</Alert.Description>
			</Alert.Root>
		{/if}

		<SectionCard title="1. Dépôt" description="Détection : docker-compose.prod.yml › docker-compose.yml › compose.yaml › Dockerfile seul." icon={FolderGit2}>
			<div class="space-y-4">
				<RepoPicker bind:value={repo} onSelect={onRepo} />
				{#if inspecting}
					<p class="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Analyse du dépôt…</p>
				{:else if inspectError}
					<Alert.Root variant="destructive"><CircleX /><Alert.Description>{inspectError}</Alert.Description></Alert.Root>
				{:else if inspection}
					<div class={cn('flex items-start gap-3 rounded-lg border p-3', inspection.detection.supported ? 'border-success/30 bg-success/5' : 'border-danger/30 bg-danger/5')}>
						{#if inspection.detection.supported}<CircleCheck class="mt-0.5 size-4 shrink-0 text-success" />{:else}<CircleX class="mt-0.5 size-4 shrink-0 text-danger" />{/if}
						<div class="min-w-0 space-y-1 text-sm">
							<p class="font-medium">{inspection.detection.reason}</p>
							<p class="text-xs text-muted-foreground">
								Branche <span class="font-mono">{inspection.repo.defaultBranch}</span>
								{#if inspection.detection.found.length}· fichiers trouvés : {#each inspection.detection.found as f (f)}<code class="mx-0.5 rounded bg-muted px-1">{f}</code>{/each}{/if}
							</p>
						</div>
					</div>

					{#if inspection.subdirs.length || workdir !== '.'}
						<div class="space-y-2">
							<Label>Dossier de travail</Label>
							<div class="flex flex-wrap gap-2">
								{#each ['.', ...inspection.subdirs.map((s) => s.path)] as dir (dir)}
									<Button
										variant={workdir === dir ? 'secondary' : 'outline'}
										size="sm"
										class={cn('font-mono', workdir === dir && 'ring-2 ring-ember/40')}
										onclick={() => {
											workdir = dir;
											void inspect(repo, dir);
										}}>{dir === '.' ? './ (racine)' : `./${dir}`}</Button
									>
								{/each}
							</div>
						</div>
					{/if}

					{#if inspection.linkedProject}
						<Alert.Root variant="destructive"
							><TriangleAlert /><Alert.Description
								>Ce dépôt est déjà lié au projet Forge « <a class="underline" href="/projects/{inspection.linkedProject}">{inspection.linkedProject}</a> » : un dépôt ne peut servir qu'à un seul projet.</Alert.Description
							></Alert.Root
						>
					{/if}
					{#each inspection.selfHosted as w (w.file)}
						<Alert.Root class="border-warning/40 text-warning">
							<ShieldAlert />
							<Alert.Title>Workflow self-hosted existant : {w.file}</Alert.Title>
							<Alert.Description class="text-warning/90">
								Jobs {w.jobs.join(', ')} sur [{w.labels.join(', ')}]{w.triggersOnPush ? ', déclenché à chaque push' : ''}. Risque de double déploiement : désactivez-le après la migration.
							</Alert.Description>
						</Alert.Root>
					{/each}
					{#if inspection.hasForgeWorkflow}
						<Alert.Root><FileCode /><Alert.Description>.github/workflows/forge-deploy.yml existe déjà : il ne sera pas modifié.</Alert.Description></Alert.Root>
					{/if}
				{/if}
			</div>
		</SectionCard>

		<SectionCard title="2. Identité" description="L'identifiant sert de hostname du CT, de nom et de label du runner." icon={Settings2}>
			<div class="grid gap-4 sm:grid-cols-2">
				<div class="space-y-2">
					<Label for="name">Nom affiché</Label>
					<Input id="name" name="name" bind:value={name} placeholder="Mon application" />
				</div>
				<div class="space-y-2">
					<Label for="slug">Identifiant</Label>
					<Input
						id="slug"
						name="slug"
						bind:value={slug}
						oninput={() => (slugTouched = true)}
						class="font-mono"
						placeholder="mon-app"
						aria-invalid={slug !== '' && !slugOk}
					/>
					{#if slug && !slugOk}<p class="text-xs text-danger">Minuscules, chiffres et tirets, 40 caractères max.</p>{/if}
				</div>
			</div>
		</SectionCard>

		<SectionCard title="3. Domaines" description="Un enregistrement A vers {data.publicIp} par domaine (jamais d'AAAA), puis un proxy host NPM avec Let's Encrypt." icon={Globe}>
			{#if data.zonesError}
				<Alert.Root class="mb-4 border-warning/40 text-warning"><TriangleAlert /><Alert.Description class="text-warning/90">Zones OVH indisponibles : {data.zonesError}</Alert.Description></Alert.Root>
			{/if}
			<DomainEditor bind:rows={domains} zones={data.zones} publicIp={data.publicIp} />
		</SectionCard>

		<SectionCard title="4. Application" icon={Server}>
			<div class="space-y-5">
				<div class="grid gap-4 sm:grid-cols-2">
					<div class="space-y-2">
						<Label for="appPort">Port de l'app</Label>
						<Input id="appPort" name="appPort" type="number" min={1} max={65535} bind:value={appPort} class="font-mono" />
						<p class="text-xs text-muted-foreground">Port exposé sur le CT, cible du proxy NPM.</p>
					</div>
					<div class="space-y-2">
						<Label>Service principal</Label>
						{#if inspection?.composeServices.length && inspection.detection.mode === 'compose'}
							<Select.Root type="single" bind:value={appService}>
								<Select.Trigger class="w-full font-mono">{appService}</Select.Trigger>
								<Select.Content>
									{#each inspection.composeServices as s (s)}<Select.Item value={s} label={s} class="font-mono">{s}</Select.Item>{/each}
								</Select.Content>
							</Select.Root>
						{:else}
							<Input bind:value={appService} class="font-mono" disabled={inspection?.detection.mode === 'dockerfile'} />
						{/if}
						<p class="text-xs text-muted-foreground">Le service qui écoute sur ce port.</p>
					</div>
				</div>

				{#if inspection?.detection.mode === 'compose'}
					<div class="space-y-2">
						<Label class="flex items-center gap-1.5"><Database class="size-3.5" /> Base de données</Label>
						{#if sqlDbs.length}
							<Select.Root type="single" bind:value={dbService}>
								<Select.Trigger class="w-full sm:w-80">
									{#if dbService}{DB_LABEL[sqlDbs.find((d) => d.service === dbService)?.kind ?? 'postgres']} · <span class="font-mono">{dbService}</span>{:else}Pas de sauvegarde automatique{/if}
								</Select.Trigger>
								<Select.Content>
									{#each sqlDbs as d (d.service)}<Select.Item value={d.service} label={d.service}>{DB_LABEL[d.kind]} · <span class="font-mono">{d.service}</span></Select.Item>{/each}
									<Select.Item value="" label="Aucune">Pas de sauvegarde automatique</Select.Item>
								</Select.Content>
							</Select.Root>
							<p class="text-xs text-muted-foreground">
								Dump SQL avant chaque déploiement (10 derniers gardés sur le CT), plus l'onglet « Base de données » : tables, console SQL, sauvegardes et restauration.
							</p>
						{:else}
							<p class="text-xs text-muted-foreground">Aucune base PostgreSQL / MySQL / MariaDB détectée dans le compose.</p>
						{/if}
					</div>

					{#if migrations.length}
						<div class="flex items-start gap-3 rounded-lg border border-success/30 bg-success/5 p-3 text-sm">
							<CircleCheck class="mt-0.5 size-4 shrink-0 text-success" />
							<p>
								<span class="font-medium">Migrations gérées par compose</span> — {#each migrations as m, i (m.service)}{i ? ', ' : ''}<code class="rounded bg-muted px-1">{m.service}</code> attendu par {m.requiredBy.join(', ')}{/each}.
								<span class="text-muted-foreground">Elles tournent avant le démarrage de l'app, et le déploiement s'arrête si elles échouent.</span>
							</p>
						</div>
					{:else if sqlDbs.length}
						<details class="group rounded-lg border border-info/30 bg-info/5 p-3 text-sm">
							<summary class="flex cursor-pointer list-none items-start gap-3">
								<Info class="mt-0.5 size-4 shrink-0 text-info" />
								<span class="min-w-0 flex-1">
									<span class="font-medium">Conseil : faites tourner les migrations dans compose.</span>
									<span class="text-muted-foreground">Un service « migrate » attendu par l'app garantit que la base est à jour avant que la nouvelle version démarre.</span>
								</span>
								<ChevronRight class="mt-0.5 size-4 shrink-0 transition-transform group-open:rotate-90" />
							</summary>
							<CodeBlock class="mt-3" title={inspection.detection.file ?? 'docker-compose.yml'} code={migrationSnippet(appService, dbService || null, postDeploy || 'npx drizzle-kit migrate')} />
						</details>
					{/if}
				{/if}

				<details class="group">
					<summary class="flex cursor-pointer list-none items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
						<ChevronRight class="size-4 transition-transform group-open:rotate-90" /> Avancé : commande post-déploiement
					</summary>
					<div class="mt-3 space-y-2">
						<Input id="postDeploy" name="postDeploy" bind:value={postDeploy} placeholder="npx drizzle-kit migrate" class="font-mono" />
						<p class="text-xs text-muted-foreground">
							Lancée APRÈS le démarrage, via <code>docker compose exec -T {appService}</code> : l'app tourne quelques secondes sur l'ancien schéma. Préférez un service compose (ci-dessus).
						</p>
					</div>
				</details>
			</div>
		</SectionCard>

		<SectionCard title="5. Conteneur" description="Clone complet du template 900 (Docker + runner) dans le pool forge." icon={Server}>
			<div class="space-y-4">
				<SizePicker bind:value={size} freeMb={preview?.ram.freeMb ?? null} totalMb={preview?.memTotalMb ?? null} />
				{#if ram?.level === 'tight'}
					<label class="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
						<Checkbox bind:checked={ackRam} name="acknowledgeRam" class="mt-0.5" />
						<span>
							<span class="font-medium text-warning">RAM serrée</span> — il ne resterait que {Math.round(ram.afterMb)} Mo libres sur l'hôte. Je confirme vouloir créer ce CT.
						</span>
					</label>
				{:else if ram?.level === 'insufficient'}
					<Alert.Root variant="destructive"><CircleX /><Alert.Description>RAM insuffisante sur l'hôte pour la taille {size} : choisissez une taille plus petite.</Alert.Description></Alert.Root>
				{/if}
			</div>
		</SectionCard>

		<SectionCard title="6. Variables d'environnement" description="Collez votre .env : il devient le secret ENV_FILE, écrit dans .env à chaque déploiement." icon={KeyRound}>
			<div class="space-y-4">
				{#if inspection}
					<EnvTemplatePanel template={inspection.envTemplate} composeRefs={inspection.compose?.envRefs ?? []} bind:value={env} fqdn={firstFqdn} {appPort} />
				{/if}
				<EnvEditor bind:value={env} />
				{#if envUnresolved > 0}
					<label class="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
						<Checkbox bind:checked={ackEnv} class="mt-0.5" />
						<span><span class="font-medium text-warning">{envUnresolved} variable(s) attendue(s) non renseignée(s)</span> — je déploie quand même (modifiable ensuite dans l'onglet Variables).</span>
					</label>
				{/if}
			</div>
		</SectionCard>
	</div>

	<aside class="xl:sticky xl:top-6 xl:self-start">
		<SectionCard title="Récapitulatif">
			<dl class="divide-y">
				<KeyValue label="Dépôt" mono>{repo || '—'}</KeyValue>
				<KeyValue label="Mode">
					{#if inspection?.detection.supported}<Badge variant="secondary">{inspection.detection.mode === 'compose' ? 'Compose' : 'Dockerfile'}</Badge>{:else}—{/if}
				</KeyValue>
				<KeyValue label="Dossier" mono>{workdir === '.' ? './' : `./${workdir}`}</KeyValue>
				<KeyValue label="CT" mono>{preview?.ctid ?? '…'} · {slug || '—'}</KeyValue>
				<KeyValue label="IP (indicative)" mono>{preview?.ip ?? '…'}</KeyValue>
				<KeyValue label="Taille">{size} · {SIZES[size].cores} cœur(s), {SIZES[size].memoryMb / 1024} Go, {SIZES[size].diskGb} Go</KeyValue>
				<KeyValue label="Domaines" mono>
					{#each domains.filter((d) => d.zone) as d (d.id)}<div>{buildFqdn(d.subdomain, d.zone)}</div>{:else}—{/each}
				</KeyValue>
				<KeyValue label=".env">{envParsed.entries.length} variable(s)</KeyValue>
			</dl>
			{#snippet footer()}
				<div class="w-full space-y-3">
					{#if data.dryRun}
						<p class="flex items-start gap-1.5 text-xs text-warning"><Info class="mt-px size-3.5 shrink-0" /> DRY-RUN : le job sera entièrement simulé.</p>
					{/if}
					<Button type="submit" size="lg" class="w-full bg-ember text-ember-foreground hover:bg-ember/90" disabled={!canSubmit}>
						{#if submitting}<Spinner />{:else}<Rocket />{/if}
						Déployer
					</Button>
					<p class="text-center text-xs text-muted-foreground">Le commit du workflow vous sera montré pour confirmation.</p>
				</div>
			{/snippet}
		</SectionCard>
	</aside>
</form>

<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import type { SubmitFunction } from '@sveltejs/kit';
	import PlugZap from '@lucide/svelte/icons/plug-zap';
	import Server from '@lucide/svelte/icons/server';
	import Network from '@lucide/svelte/icons/network';
	import Globe from '@lucide/svelte/icons/globe';
	import Waypoints from '@lucide/svelte/icons/waypoints';
	import KeySquare from '@lucide/svelte/icons/key-square';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Save from '@lucide/svelte/icons/save';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import FlaskConical from '@lucide/svelte/icons/flask-conical';
	import History from '@lucide/svelte/icons/history';
	import PageHeader from '$lib/components/molecules/page-header.svelte';
	import SectionCard from '$lib/components/molecules/section-card.svelte';
	import SettingField from '$lib/components/molecules/setting-field.svelte';
	import CopyButton from '$lib/components/molecules/copy-button.svelte';
	import ConfirmDialog from '$lib/components/molecules/confirm-dialog.svelte';
	import RelativeTime from '$lib/components/molecules/relative-time.svelte';
	import StatusBadge from '$lib/components/molecules/status-badge.svelte';
	import ConnectionReport from '$lib/components/organisms/connection-report.svelte';
	import GithubIcon from '$lib/components/atoms/github-icon.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import { Switch } from '$lib/components/atoms/ui/switch';
	import { Input } from '$lib/components/atoms/ui/input';
	import { Label } from '$lib/components/atoms/ui/label';
	import { Badge } from '$lib/components/atoms/ui/badge';
	import * as Tabs from '$lib/components/atoms/ui/tabs';
	import * as Alert from '$lib/components/atoms/ui/alert';
	import Spinner from '$lib/components/atoms/spinner.svelte';
	import type { CheckSection, PermissionRow } from '$server/application/use-cases/connections';

	let { data, form } = $props();
	const v = $derived(data.values);
	const set = $derived(data.secretsSet);

	let tab = $state('connections');
	let testing = $state(false);
	let report = $state<{ sections: CheckSection[]; permissions: PermissionRow[]; checkedAt: number } | null>(null);
	let keyConfirm = $state(false);
	let keyForm: HTMLFormElement | undefined = $state();
	let dryForm: HTMLFormElement | undefined = $state();

	const saveHandler: SubmitFunction = () => {
		return async ({ result, update }) => {
			await update({ reset: false });
			if (result.type === 'success') toast.success('Réglages enregistrés');
			if (result.type === 'failure') toast.error((result.data as { error?: string })?.error ?? 'Erreur');
		};
	};

	const testHandler: SubmitFunction = () => {
		testing = true;
		return async ({ result }) => {
			testing = false;
			if (result.type === 'success') {
				report = (result.data as { report: typeof report }).report;
				const bad = report?.sections.filter((s) => s.status === 'error').length ?? 0;
				if (bad) toast.error(`${bad} connexion(s) en erreur`);
				else toast.success('Toutes les connexions répondent');
			}
		};
	};

	const tabs = [
		{ value: 'connections', label: 'Connexions', icon: PlugZap },
		{ value: 'proxmox', label: 'Proxmox', icon: Server },
		{ value: 'network', label: 'Réseau & plages', icon: Network },
		{ value: 'github', label: 'GitHub', icon: GithubIcon },
		{ value: 'ovh', label: 'OVH', icon: Globe },
		{ value: 'npm', label: 'NPM', icon: Waypoints },
		{ value: 'ssh', label: 'Clé SSH', icon: KeySquare },
		{ value: 'security', label: 'Sécurité', icon: ShieldCheck }
	];
</script>

<svelte:head><title>Réglages · Forge</title></svelte:head>

<PageHeader title="Réglages" description="Les jetons sont chiffrés en base (AES-256-GCM) et ne sont jamais renvoyés au navigateur." />

<Tabs.Root bind:value={tab} class="gap-6">
	<Tabs.List class="scrollbar-thin h-auto w-full justify-start overflow-x-auto">
		{#each tabs as t (t.value)}
			<Tabs.Trigger value={t.value} class="flex-none gap-1.5"><t.icon class="size-4" />{t.label}</Tabs.Trigger>
		{/each}
	</Tabs.List>

	<!-- Connexions -->
	<Tabs.Content value="connections" class="space-y-6">
		<SectionCard title="Tester les connexions" description="Lectures seules sur chaque API, vérification des permissions, et preuve que Forge ne peut pas écrire sur les CT de production." icon={PlugZap}>
			{#snippet actions()}
				<form method="POST" action="?/test" use:enhance={testHandler}>
					<Button type="submit" size="sm" disabled={testing}>
						{#if testing}<Spinner />{:else}<RefreshCw />{/if}
						Tester les connexions
					</Button>
				</form>
			{/snippet}
			{#if report}
				<p class="mb-4 text-xs text-muted-foreground">Vérifié <RelativeTime value={report.checkedAt} /></p>
				<ConnectionReport sections={report.sections} permissions={report.permissions} />
			{:else}
				<p class="text-sm text-muted-foreground">Lancez le test pour vérifier Proxmox, GitHub, OVH, NPM, la clé SSH et la résolution DNS publique.</p>
			{/if}
		</SectionCard>

		<SectionCard title="Dernières écritures (garde de sécurité)" description="Toutes les écritures passent par le garde : exécutées, simulées (DRY-RUN) ou refusées." icon={History} bodyClass="p-0">
			{#if data.audit.length === 0}
				<p class="px-5 py-6 text-sm text-muted-foreground">Aucune écriture depuis le démarrage.</p>
			{:else}
				<ul class="divide-y text-sm">
					{#each data.audit as a, i (i)}
						<li class="flex items-start gap-3 px-5 py-2.5">
							<StatusBadge
								info={{
									label: { executed: 'exécuté', simulated: 'simulé', refused: 'refusé', failed: 'échec' }[a.outcome],
									tone: a.outcome === 'executed' ? 'success' : a.outcome === 'simulated' ? 'info' : 'danger'
								}}
							/>
							<span class="min-w-0 flex-1">
								<span class="font-medium uppercase">{a.system}</span> · {a.summary}
								{#if a.error}<span class="block text-xs text-danger">{a.error}</span>{/if}
							</span>
							<span class="shrink-0 text-xs text-muted-foreground"><RelativeTime value={a.ts} /></span>
						</li>
					{/each}
				</ul>
			{/if}
		</SectionCard>
	</Tabs.Content>

	<!-- Proxmox -->
	<Tabs.Content value="proxmox">
		<form method="POST" action="?/save" use:enhance={saveHandler}>
			<input type="hidden" name="_section" value="proxmox" />
			<SectionCard title="Proxmox VE" description="Jeton créé par infra/02-proxmox-forge-access.sh (utilisateur forge@pve, privsep)." icon={Server}>
				<div class="grid gap-5 md:grid-cols-2">
					<SettingField name="proxmox.url" label="URL de l'API" value={v['proxmox.url']} help="Via le bridge nat ou Tailscale : https://10.10.10.1:8006" />
					<SettingField name="proxmox.node" label="Nœud" value={v['proxmox.node']} />
					<SettingField name="proxmox.tokenId" label="ID du jeton" value={v['proxmox.tokenId']} />
					<SettingField name="proxmox.tokenSecret" label="Secret du jeton" secret secretSet={set['proxmox.tokenSecret']} placeholder="xxxxxxxx-xxxx-…" />
					<SettingField name="proxmox.pool" label="Pool Forge" value={v['proxmox.pool']} help="Seuls les CT de ce pool sont modifiables." />
					<SettingField name="proxmox.templateId" label="Template à cloner" value={v['proxmox.templateId']} />
					<SettingField name="proxmox.storage" label="Stockage des disques" value={v['proxmox.storage']} />
					<SettingField name="proxmox.backupStorage" label="Stockage des sauvegardes" value={v['proxmox.backupStorage']} />
					<SettingField name="proxmox.bridge" label="Bridge" value={v['proxmox.bridge']} />
					<div class="md:col-span-2">
						<SettingField
							name="proxmox.caCert"
							label="Certificat CA de Proxmox (pve-root-ca.pem)"
							value={v['proxmox.caCert']}
							multiline
							placeholder="-----BEGIN CERTIFICATE-----"
							help="Affiché à la fin de infra/02. Sans lui, le certificat auto-signé n'est pas vérifié."
						/>
					</div>
				</div>
				{#snippet footer()}<Button type="submit" size="sm"><Save /> Enregistrer</Button>{/snippet}
			</SectionCard>
		</form>
	</Tabs.Content>

	<!-- Réseau -->
	<Tabs.Content value="network">
		<form method="POST" action="?/save" use:enhance={saveHandler}>
			<input type="hidden" name="_section" value="network" />
			<SectionCard title="Réseau et plages réservées" description="L'IP libre est calculée sur la config réseau de TOUS les CT/VM, puis vérifiée par ping/ARP." icon={Network}>
				<div class="grid gap-5 md:grid-cols-2">
					<SettingField name="network.publicIp" label="IP publique (cible des enregistrements A)" value={v['network.publicIp']} help="Jamais d'AAAA : le 80/443 n'est redirigé qu'en IPv4." />
					<SettingField name="network.gateway" label="Passerelle" value={v['network.gateway']} />
					<SettingField name="network.ipStart" label="Première IP Forge" value={v['network.ipStart']} />
					<SettingField name="network.ipEnd" label="Dernière IP Forge" value={v['network.ipEnd']} />
					<SettingField name="network.cidr" label="Masque (CIDR)" value={v['network.cidr']} />
					<SettingField name="network.reservedIps" label="IP jamais attribuées" value={v['network.reservedIps']} help="Séparées par des virgules (ex. 10.10.10.50 : ancienne règle Palworld)." />
					<SettingField name="network.npmIp" label="IP de Nginx Proxy Manager" value={v['network.npmIp']} help="Seule source autorisée vers le port des apps (pare-feu)." />
					<SettingField name="network.forgeIp" label="IP de Forge (CT 150)" value={v['network.forgeIp']} help="Autorisée en SSH vers les CT de projet." />
					<SettingField name="network.nameserver" label="DNS des CT de projet" value={v['network.nameserver']} help="IP séparées par des espaces (ex. 1.1.1.1 9.9.9.9), appliquées à la configuration du CT. Vide : hérité de l'hôte (Tailscale MagicDNS)." />
					<SettingField name="firewall.enabled" label="Pare-feu par CT (true / false)" value={v['firewall.enabled']} help="Isole chaque projet des autres CT du bridge, prod comprise. Nécessite infra/05-firewall.sh." />
					<SettingField name="ctid.min" label="Premier CTID" value={v['ctid.min']} />
					<SettingField name="ctid.max" label="Dernier CTID" value={v['ctid.max']} />
					<div class="md:col-span-2">
						<SettingField name="safety.protectedCtids" label="CT de production protégés" value={v['safety.protectedCtids']} help="Défense supplémentaire : aucune action possible sur ces CT, même dans le pool." />
					</div>
					<div class="md:col-span-2">
						<SettingField
							name="dashboard.repoMap"
							label="Correspondance CT → dépôt (dashboard)"
							value={v['dashboard.repoMap']}
							multiline
							help={'Optionnel. Par défaut, le dépôt est deviné via le nom du runner (= hostname). Ex. {"402": "BastienGRNT/crystal_wallet"}'}
						/>
					</div>
				</div>
				{#snippet footer()}<Button type="submit" size="sm"><Save /> Enregistrer</Button>{/snippet}
			</SectionCard>
		</form>
	</Tabs.Content>

	<!-- GitHub -->
	<Tabs.Content value="github">
		<form method="POST" action="?/save" use:enhance={saveHandler}>
			<input type="hidden" name="_section" value="github" />
			<SectionCard title="GitHub" description="Jeton fine-grained : Administration, Secrets, Variables, Actions, Contents, Workflows en écriture, Metadata en lecture." icon={GithubIcon}>
				<div class="grid gap-5 md:grid-cols-2">
					<SettingField name="github.owner" label="Propriétaire des dépôts" value={v['github.owner']} />
					<SettingField name="github.token" label="Jeton fine-grained" secret secretSet={set['github.token']} placeholder="github_pat_…" />
				</div>
				<div class="mt-4">
					<Button variant="link" size="sm" class="px-0" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
						Créer un jeton fine-grained <ExternalLink />
					</Button>
				</div>
				{#snippet footer()}<Button type="submit" size="sm"><Save /> Enregistrer</Button>{/snippet}
			</SectionCard>
		</form>
	</Tabs.Content>

	<!-- OVH -->
	<Tabs.Content value="ovh" class="space-y-6">
		<form method="POST" action="?/save" use:enhance={saveHandler}>
			<input type="hidden" name="_section" value="ovh" />
			<SectionCard title="OVH API" description="Droits limités aux enregistrements des zones (jamais /reset ni /import)." icon={Globe}>
				<div class="grid gap-5 md:grid-cols-2">
					<SettingField name="ovh.endpoint" label="Endpoint" value={v['ovh.endpoint']} />
					<SettingField name="ovh.appKey" label="Application key" value={v['ovh.appKey']} />
					<SettingField name="ovh.appSecret" label="Application secret" secret secretSet={set['ovh.appSecret']} />
					<SettingField name="ovh.consumerKey" label="Consumer key" secret secretSet={set['ovh.consumerKey']} />
				</div>
				{#snippet footer()}<Button type="submit" size="sm"><Save /> Enregistrer</Button>{/snippet}
			</SectionCard>
		</form>
		<SectionCard title="Créer les clés OVH" description="Lien createToken avec les droits minimaux par zone. Choisissez une validité « Unlimited » si vous le souhaitez.">
			<div class="space-y-4 text-sm">
				<div class="space-y-1.5">
					<p class="font-medium">Recommandé (avec suppression des enregistrements créés par Forge)</p>
					<div class="flex items-center gap-2">
						<code class="block min-w-0 flex-1 truncate rounded-lg border bg-muted/40 px-3 py-2 text-xs">{data.ovhTokenUrl}</code>
						<CopyButton value={data.ovhTokenUrl} />
						<Button variant="outline" size="sm" href={data.ovhTokenUrl} target="_blank" rel="noreferrer">Ouvrir <ExternalLink /></Button>
					</div>
				</div>
				<div class="space-y-1.5">
					<p class="font-medium">Sans DELETE (rollback DNS manuel)</p>
					<div class="flex items-center gap-2">
						<code class="block min-w-0 flex-1 truncate rounded-lg border bg-muted/40 px-3 py-2 text-xs">{data.ovhTokenUrlNoDelete}</code>
						<CopyButton value={data.ovhTokenUrlNoDelete} />
					</div>
				</div>
			</div>
		</SectionCard>
	</Tabs.Content>

	<!-- NPM -->
	<Tabs.Content value="npm">
		<form method="POST" action="?/save" use:enhance={saveHandler}>
			<input type="hidden" name="_section" value="npm" />
			<SectionCard title="Nginx Proxy Manager" description="Compte dédié non admin, sans 2FA : Proxy hosts « manage », Certificats « manage », visibilité « tous »." icon={Waypoints}>
				<div class="grid gap-5 md:grid-cols-2">
					<SettingField name="npm.url" label="URL de l'admin NPM" value={v['npm.url']} />
					<SettingField name="npm.identity" label="Email du compte" value={v['npm.identity']} />
					<SettingField name="npm.secret" label="Mot de passe du compte" secret secretSet={set['npm.secret']} />
					<SettingField
						name="letsencrypt.email"
						label="Email Let's Encrypt"
						value={v['letsencrypt.email']}
						help="NPM 2.16 utilise en fait l'email du compte NPM : mettez le même."
					/>
				</div>
				{#snippet footer()}<Button type="submit" size="sm"><Save /> Enregistrer</Button>{/snippet}
			</SectionCard>
		</form>
	</Tabs.Content>

	<!-- SSH -->
	<Tabs.Content value="ssh">
		<SectionCard title="Clé SSH de Forge" description="Forge se connecte aux CT avec cette clé (root pour svc.sh, github pour le runner). La clé privée reste chiffrée en base." icon={KeySquare}>
			{#if v['ssh.publicKey']}
				<div class="space-y-3">
					<div class="flex items-center gap-2">
						<code class="block min-w-0 flex-1 truncate rounded-lg border bg-muted/40 px-3 py-2 text-xs">{v['ssh.publicKey']}</code>
						<CopyButton value={v['ssh.publicKey']} />
					</div>
					<p class="text-xs text-muted-foreground">Empreinte : <span class="font-mono">{data.sshFingerprint}</span></p>
					<div class="rounded-lg border bg-muted/30 p-3 text-xs">
						<p class="mb-2 font-medium">Sur l'hôte Proxmox :</p>
						<code class="block font-mono break-all">bash infra/03-template-docker-runner.sh "{v['ssh.publicKey']}"</code>
					</div>
				</div>
			{:else}
				<p class="text-sm text-muted-foreground">Aucune clé. Générez-la, puis passez la clé publique au script du template.</p>
			{/if}
			{#snippet footer()}
				<form method="POST" action="?/generateKey" bind:this={keyForm} use:enhance={() => async ({ update }) => { await update(); toast.success('Nouvelle clé générée'); }}>
					<Button type="button" size="sm" variant={v['ssh.publicKey'] ? 'outline' : 'default'} onclick={() => (v['ssh.publicKey'] ? (keyConfirm = true) : keyForm?.requestSubmit())}>
						<KeySquare /> {v['ssh.publicKey'] ? 'Régénérer la clé' : 'Générer la clé ed25519'}
					</Button>
				</form>
			{/snippet}
		</SectionCard>
	</Tabs.Content>

	<!-- Sécurité -->
	<Tabs.Content value="security" class="space-y-6">
		<SectionCard title="Mode d'exécution" icon={ShieldCheck}>
			<dl class="space-y-4 text-sm">
				<div class="flex items-center justify-between gap-4">
					<div>
						<dt class="font-medium">Mode</dt>
						<dd class="text-xs text-muted-foreground">FORGE_MODE — {data.mode === 'mock' ? 'infrastructure simulée en mémoire' : 'vraies API'}</dd>
					</div>
					<Badge variant={data.mode === 'mock' ? 'secondary' : 'default'}>{data.mode === 'mock' ? 'MOCK (démo)' : 'LIVE'}</Badge>
				</div>
				<div class="flex items-center justify-between gap-4">
					<div>
						<dt class="font-medium">DRY-RUN</dt>
						<dd class="text-xs text-muted-foreground">
							{#if data.mode === 'mock'}Modifiable ici en mode démo pour essayer les deux comportements.{:else}Défini par la variable d'environnement DRY_RUN (redémarrage nécessaire).{/if}
						</dd>
					</div>
					{#if data.mode === 'mock'}
						<form method="POST" action="?/dryRun" bind:this={dryForm} use:enhance={() => async ({ update }) => { await update(); await invalidateAll(); toast.info('DRY-RUN modifié'); }}>
							<input type="hidden" name="value" value={data.dryRun ? 'false' : 'true'} />
							<Switch checked={data.dryRun} onCheckedChange={() => dryForm?.requestSubmit()} aria-label="DRY-RUN" />
						</form>
					{:else}
						<Badge variant={data.dryRun ? 'outline' : 'destructive'}>{data.dryRun ? 'ACTIVÉ' : 'DÉSACTIVÉ'}</Badge>
					{/if}
				</div>
				<div class="flex items-center justify-between gap-4">
					<div>
						<dt class="font-medium">Sources autorisées</dt>
						<dd class="text-xs text-muted-foreground">FORGE_ALLOWED_SOURCES — via Tailscale, les requêtes arrivent depuis 10.10.10.1 (SNAT).</dd>
					</div>
					<span class="font-mono text-xs">{data.allowedSources.join(', ')}</span>
				</div>
				{#if data.masterKeyFallback}
					<Alert.Root class="border-warning/40 text-warning"><Alert.Description class="text-warning/90">FORGE_MASTER_KEY absente : clé de démonstration (mode mock uniquement).</Alert.Description></Alert.Root>
				{/if}
			</dl>
			{#snippet footer()}
				{#if data.mode === 'mock'}
					<form method="POST" action="?/resetMock" use:enhance={() => async ({ result, update }) => { await update(); if (result.type === 'success') toast.success('Démo réinitialisée'); else toast.error('Réinitialisation impossible'); }}>
						<Button type="submit" variant="outline" size="sm"><FlaskConical /> Réinitialiser la démo</Button>
					</form>
				{:else}
					<span class="text-xs text-muted-foreground">Mode live : aucune option de démo.</span>
				{/if}
			{/snippet}
		</SectionCard>

		<form method="POST" action="?/password" use:enhance>
			<SectionCard title="Mot de passe administrateur" description="Changer le mot de passe déconnecte toutes les sessions.">
				{#if form && 'section' in form && form.section === 'account' && 'error' in form && form.error}
					<Alert.Root variant="destructive" class="mb-4"><Alert.Description>{form.error}</Alert.Description></Alert.Root>
				{/if}
				<div class="grid gap-4 md:grid-cols-3">
					<div class="space-y-1.5"><Label for="current">Actuel</Label><Input id="current" name="current" type="password" autocomplete="current-password" required /></div>
					<div class="space-y-1.5"><Label for="next">Nouveau</Label><Input id="next" name="next" type="password" autocomplete="new-password" minlength={12} required /></div>
					<div class="space-y-1.5"><Label for="confirm">Confirmation</Label><Input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength={12} required /></div>
				</div>
				{#snippet footer()}<Button type="submit" size="sm"><Save /> Changer le mot de passe</Button>{/snippet}
			</SectionCard>
		</form>
	</Tabs.Content>
</Tabs.Root>

<ConfirmDialog
	bind:open={keyConfirm}
	title="Régénérer la clé SSH ?"
	description="L'ancienne clé ne sera plus utilisable par Forge : il faudra installer la nouvelle dans le template 900 et dans les CT existants."
	confirmLabel="Régénérer"
	destructive
	onConfirm={() => keyForm?.requestSubmit()}
/>

<script lang="ts">
	import { enhance } from '$app/forms';
	import Globe from '@lucide/svelte/icons/globe';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Plus from '@lucide/svelte/icons/plus';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import SectionCard from '$lib/components/molecules/section-card.svelte';
	import StatusBadge from '$lib/components/molecules/status-badge.svelte';
	import ConfirmDialog from '$lib/components/molecules/confirm-dialog.svelte';
	import DomainEditor, { type DomainRow } from '$lib/components/organisms/domain-editor.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import { Badge } from '$lib/components/atoms/ui/badge';
	import * as Alert from '$lib/components/atoms/ui/alert';
	import { daysUntil } from '$lib/format';
	import { cn } from '$lib/utils';

	let { data, form } = $props();
	let rows = $state<DomainRow[]>([]);
	let toRemove = $state<{ id: number; fqdn: string } | null>(null);
	let confirmOpen = $state(false);
	let removeForm: HTMLFormElement | undefined = $state();
	const row = $derived(rows[0]);
</script>

<svelte:head><title>Domaines · {data.project.name} · Forge</title></svelte:head>

<div class="space-y-6">
	{#if form?.error}<Alert.Root variant="destructive"><Alert.Description>{form.error}</Alert.Description></Alert.Root>{/if}
	{#if data.view.error}<Alert.Root variant="destructive"><Alert.Description>NPM : {data.view.error}</Alert.Description></Alert.Root>{/if}

	<SectionCard title="Domaines" description="Un proxy host NPM et un certificat Let's Encrypt par domaine, vers http://{data.project.ip}:{data.project.appPort}." icon={Globe} bodyClass="p-0">
		<ul class="divide-y">
			{#each data.view.domains as d (d.id)}
				{@const days = daysUntil(d.certExpiresOn)}
				<li class="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-2">
							<a href="https://{d.fqdn}" target="_blank" rel="noreferrer" class="inline-flex items-center gap-1.5 font-mono text-sm font-medium hover:underline">
								{d.fqdn}<ExternalLink class="size-3 text-muted-foreground" />
							</a>
							<StatusBadge status={d.status} />
							<Badge variant="outline">{d.mode === 'ovh' ? 'DNS OVH' : 'DNS manuel'}</Badge>
						</div>
						<p class="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
							{#if d.forward}<span class="font-mono">→ {d.forward}</span>{/if}
							{#if d.proxyHostId}<span>proxy host #{d.proxyHostId}</span>{/if}
						</p>
					</div>
					<div class="flex items-center gap-3">
						{#if days !== null}
							<span class={cn('inline-flex items-center gap-1.5 text-xs', days < 15 ? 'text-warning' : 'text-success')}>
								{#if days < 15}<ShieldAlert class="size-3.5" />{:else}<ShieldCheck class="size-3.5" />{/if}
								Certificat : expire dans {days} j
							</span>
						{:else if d.status === 'active'}
							<span class="text-xs text-muted-foreground">Certificat : inconnu</span>
						{/if}
						<Button
							variant="ghost"
							size="icon-sm"
							title="Retirer"
							disabled={!!data.activeJob || data.view.domains.length <= 1}
							onclick={() => {
								toRemove = { id: d.id, fqdn: d.fqdn };
								confirmOpen = true;
							}}><Trash2 class="text-muted-foreground" /></Button
						>
					</div>
				</li>
			{/each}
		</ul>
	</SectionCard>

	<SectionCard title="Ajouter un domaine" description="DNS OVH (enregistrement A vers {data.publicIp}) ou domaine externe à créer à la main." icon={Plus}>
		{#if !row}
			<Button variant="outline" size="sm" onclick={() => (rows = [{ id: 1, subdomain: '', zone: data.zones[0] ?? '', custom: data.zones.length === 0 }])}><Plus /> Nouveau domaine</Button>
		{:else}
			<DomainEditor bind:rows zones={data.zones} publicIp={data.publicIp} max={1} />
			<form method="POST" action="?/add" use:enhance class="mt-4 flex justify-end gap-2">
				<input type="hidden" name="subdomain" value={row.subdomain} />
				<input type="hidden" name="zone" value={row.zone} />
				<input type="hidden" name="managed" value={row.custom ? '0' : '1'} />
				<Button variant="ghost" size="sm" onclick={() => (rows = [])}>Annuler</Button>
				<Button type="submit" size="sm" disabled={!row.zone || !!data.activeJob}><Plus /> Ajouter (DNS + proxy + HTTPS)</Button>
			</form>
		{/if}
	</SectionCard>
</div>

<form method="POST" action="?/remove" bind:this={removeForm} use:enhance class="hidden">
	<input type="hidden" name="domainId" value={toRemove?.id ?? ''} />
</form>
<ConfirmDialog
	bind:open={confirmOpen}
	title="Retirer {toRemove?.fqdn} ?"
	description="Forge supprimera le proxy host, le certificat et l'enregistrement DNS qu'il a créés pour ce domaine. Ce qui n'a pas été créé par Forge n'est jamais touché."
	confirmLabel="Retirer le domaine"
	destructive
	onConfirm={() => removeForm?.requestSubmit()}
/>

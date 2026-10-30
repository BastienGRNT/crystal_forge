<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import PageHeader from '$lib/components/molecules/page-header.svelte';
	import SectionCard from '$lib/components/molecules/section-card.svelte';
	import CopyButton from '$lib/components/molecules/copy-button.svelte';
	import { Button } from '$lib/components/atoms/ui/button';
	import { Input } from '$lib/components/atoms/ui/input';
	import { Badge } from '$lib/components/atoms/ui/badge';
	import * as Alert from '$lib/components/atoms/ui/alert';
	import { ACCESS_LABELS, ACCESS_LEVELS } from '$lib/domain/access';

	let { data, form } = $props();
	const linkUrl = $derived(form && 'link' in form && form.link ? `${page.url.origin}/reset/${form.link.token}` : null);
	const levelOf = (u: (typeof data.users)[number], projectId: number) => u.projects.find((p) => p.projectId === projectId)?.level ?? '';
	const when = (ts: number) => new Date(ts).toLocaleString('fr-FR');
</script>

<svelte:head><title>Utilisateurs · Forge</title></svelte:head>

<PageHeader title="Utilisateurs" description="Un collaborateur ne voit que les projets que vous lui assignez : Lecture (voir), Déploiement (+ redéployer), Édition (+ variables, domaines, base, démarrer/arrêter). Réglages, serveur et suppression restent réservés à l'admin." />

<div class="space-y-6">
	{#if form && 'error' in form && form.error}
		<Alert.Root variant="destructive"><Alert.Description>{form.error}</Alert.Description></Alert.Root>
	{/if}
	{#if linkUrl && form && 'link' in form && form.link}
		<Alert.Root>
			<KeyRound />
			<Alert.Title>Lien pour {form.link.username}</Alert.Title>
			<Alert.Description>
				<p>À transmettre en privé : il permet de choisir un mot de passe, une seule fois, pendant 1 h. Il ne sera plus affichable.</p>
				<div class="mt-2 flex items-center gap-2"><code class="break-all text-xs">{linkUrl}</code><CopyButton value={linkUrl} /></div>
			</Alert.Description>
		</Alert.Root>
	{/if}

	<form method="POST" action="?/create" use:enhance>
		<SectionCard title="Inviter un collaborateur" description="Crée le compte et génère un lien pour qu'il choisisse son mot de passe." icon={UserPlus}>
			<div class="max-w-sm"><Input name="username" placeholder="identifiant (ex. marie)" required autocomplete="off" /></div>
			{#snippet footer()}<Button type="submit" size="sm"><UserPlus /> Créer</Button>{/snippet}
		</SectionCard>
	</form>

	{#each data.users as u (u.id)}
		<SectionCard title={u.username} description={u.role === 'admin' ? 'Administrateur : accès à tout.' : u.disabled ? 'Compte désactivé.' : 'Collaborateur'}>
			{#snippet actions()}
				{#if u.role === 'admin'}
					<Badge>Admin</Badge>
				{:else}
					<form method="POST" action="?/resetLink" use:enhance><input type="hidden" name="userId" value={u.id} /><Button type="submit" variant="outline" size="sm"><KeyRound /> Mot de passe oublié</Button></form>
					<form method="POST" action="?/toggle" use:enhance>
						<input type="hidden" name="userId" value={u.id} /><input type="hidden" name="disabled" value={u.disabled ? '0' : '1'} />
						<Button type="submit" variant="outline" size="sm">{u.disabled ? 'Réactiver' : 'Désactiver'}</Button>
					</form>
					<form method="POST" action="?/remove" use:enhance={({ cancel }) => { if (!confirm(`Supprimer ${u.username} ?`)) cancel(); }}>
						<input type="hidden" name="userId" value={u.id} /><Button type="submit" variant="destructive" size="sm">Supprimer</Button>
					</form>
				{/if}
			{/snippet}
			{#if u.role === 'collaborator'}
				<div class="grid gap-2 md:grid-cols-2">
					{#each data.projects as p (p.id)}
						<form method="POST" action="?/member" use:enhance class="flex items-center gap-2">
							<input type="hidden" name="userId" value={u.id} /><input type="hidden" name="projectId" value={p.id} />
							<span class="min-w-0 flex-1 truncate text-sm">{p.name}</span>
							<select name="level" class="h-8 rounded-md border bg-background px-2 text-sm" value={levelOf(u, p.id)} onchange={(e) => e.currentTarget.form?.requestSubmit()}>
								<option value="">Aucun accès</option>
								{#each ACCESS_LEVELS as l (l)}<option value={l}>{ACCESS_LABELS[l]}</option>{/each}
							</select>
						</form>
					{:else}
						<p class="text-sm text-muted-foreground">Aucun projet.</p>
					{/each}
				</div>
			{/if}
		</SectionCard>
	{/each}

	<SectionCard title="Journal des actions" description="Qui a fait quelle écriture (les 60 dernières).">
		<div class="max-h-96 overflow-auto text-xs">
			<table class="w-full">
				<tbody>
					{#each data.audit as a (a.id)}
						<tr class="border-b last:border-0">
							<td class="py-1 pr-3 whitespace-nowrap text-muted-foreground">{when(a.ts)}</td>
							<td class="pr-3 font-medium">{a.username}</td>
							<td class="pr-3 font-mono">{a.method}</td>
							<td class="pr-3 font-mono break-all">{a.path}</td>
							<td class="text-right tabular-nums">{a.status}</td>
						</tr>
					{:else}
						<tr><td class="py-2 text-muted-foreground">Rien pour l'instant.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</SectionCard>
</div>

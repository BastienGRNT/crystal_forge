<script lang="ts">
	import { onMount } from 'svelte';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import Lock from '@lucide/svelte/icons/lock';
	import Github from '$lib/components/atoms/github-icon.svelte';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import * as Popover from '$lib/components/atoms/ui/popover';
	import * as Command from '$lib/components/atoms/ui/command';
	import { Button } from '$lib/components/atoms/ui/button';
	import Spinner from '$lib/components/atoms/spinner.svelte';
	import { relativeTime } from '$lib/format';
	import type { GhRepo } from '$server/application/ports';

	let { value = $bindable(''), onSelect }: { value?: string; onSelect?: (repo: GhRepo) => void } = $props();
	let open = $state(false);
	let repos = $state<GhRepo[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	async function load(refresh = false) {
		loading = true;
		error = null;
		const res = await fetch(`/api/github/repos${refresh ? '?refresh=1' : ''}`);
		const j = (await res.json()) as { repos: GhRepo[]; error?: string };
		repos = j.repos;
		error = j.error ?? null;
		loading = false;
	}
	onMount(() => void load());
	const selected = $derived(repos.find((r) => r.fullName === value));
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline" class="h-11 w-full justify-between px-3 font-normal" role="combobox" aria-expanded={open}>
				<span class="flex min-w-0 items-center gap-2.5">
					<Github class="text-muted-foreground" />
					{#if selected}
						<span class="truncate font-medium">{selected.fullName}</span>
						{#if selected.private}<Lock class="size-3 text-muted-foreground" />{/if}
					{:else}
						<span class="text-muted-foreground">{loading ? 'Chargement des dépôts…' : 'Choisir un dépôt GitHub'}</span>
					{/if}
				</span>
				{#if loading}<Spinner />{:else}<ChevronsUpDown class="opacity-50" />{/if}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-(--bits-popover-anchor-width) min-w-80 p-0" align="start">
		<Command.Root>
			<div class="flex items-center gap-1 border-b pr-1">
				<div class="flex-1"><Command.Input placeholder="Rechercher un dépôt…" /></div>
				<Button variant="ghost" size="icon-sm" onclick={() => load(true)} title="Rafraîchir"><RefreshCw class={loading ? 'animate-spin' : ''} /></Button>
			</div>
			<Command.List class="max-h-80">
				<Command.Empty>{error ?? 'Aucun dépôt trouvé.'}</Command.Empty>
				<Command.Group>
					{#each repos as repo (repo.fullName)}
						<Command.Item
							value={`${repo.fullName} ${repo.description ?? ''}`}
							onSelect={() => {
								value = repo.fullName;
								open = false;
								onSelect?.(repo);
							}}
							class="flex flex-col items-start gap-0.5 py-2"
						>
							<span class="flex w-full items-center gap-2">
								<span class="truncate font-medium">{repo.name}</span>
								{#if repo.private}<Lock class="size-3 text-muted-foreground" />{/if}
								<span class="ml-auto shrink-0 text-xs text-muted-foreground">{relativeTime(repo.pushedAt)}</span>
							</span>
							{#if repo.description}<span class="line-clamp-1 text-xs text-muted-foreground">{repo.description}</span>{/if}
						</Command.Item>
					{/each}
				</Command.Group>
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>

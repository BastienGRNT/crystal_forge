<script lang="ts">
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import UserRound from '@lucide/svelte/icons/user-round';
	import LogOut from '@lucide/svelte/icons/log-out';
	import Sun from '@lucide/svelte/icons/sun';
	import Moon from '@lucide/svelte/icons/moon';
	import Monitor from '@lucide/svelte/icons/monitor';
	import { setMode, resetMode, userPrefersMode } from 'mode-watcher';
	import * as Popover from '$lib/components/atoms/ui/popover';
	import { cn } from '$lib/utils';

	let {
		user,
		onNavigate,
		compact = false
	}: { user: { username: string; role: 'admin' | 'collaborator' }; onNavigate?: () => void; compact?: boolean } = $props();
	let open = $state(false);
	const initials = $derived(user.username.slice(0, 2).toUpperCase());
	const themes = [
		{ value: 'light', label: 'Clair', icon: Sun },
		{ value: 'dark', label: 'Sombre', icon: Moon },
		{ value: 'system', label: 'Auto', icon: Monitor }
	] as const;
	const current = $derived(userPrefersMode.current ?? 'system');
	function pick(v: 'light' | 'dark' | 'system') {
		if (v === 'system') resetMode();
		else setMode(v);
	}
	const item = 'flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] text-foreground/90 hover:bg-accent';
</script>

<Popover.Root bind:open>
	<Popover.Trigger
		class={cn('flex w-full items-center gap-2.5 rounded-md p-1.5 text-left transition-colors hover:bg-sidebar-accent/60 data-[state=open]:bg-sidebar-accent', compact && 'justify-center p-1')}
		title={compact ? user.username : undefined}
	>
		<span class="grid size-7 shrink-0 place-items-center rounded-md bg-gradient-to-br from-ember/25 to-ember/5 font-mono text-[11px] font-semibold text-foreground ring-1 ring-ember/25">{initials}</span>
		{#if !compact}
			<span class="min-w-0 flex-1">
				<span class="block truncate text-[13px] font-medium">{user.username}</span>
				<span class="block text-[11px] text-muted-foreground">{user.role === 'admin' ? 'Administrateur' : 'Collaborateur'}</span>
			</span>
			<ChevronsUpDown class="size-3.5 text-muted-foreground" />
		{/if}
	</Popover.Trigger>
	<Popover.Content side="top" align="start" class="w-60 p-1.5">
		<a href="/account" class={item} onclick={() => { open = false; onNavigate?.(); }}><UserRound class="size-4 text-muted-foreground" /> Mon compte</a>
		<div class="my-1.5 border-t"></div>
		<p class="px-2 pb-1 text-[11px] text-muted-foreground">Thème</p>
		<div class="grid grid-cols-3 gap-1 px-1 pb-1">
			{#each themes as t (t.value)}
				<button
					type="button"
					onclick={() => pick(t.value)}
					class={cn('flex flex-col items-center gap-1 rounded-md border py-1.5 text-[11px] transition-colors', current === t.value ? 'border-ember/50 bg-ember/10 text-foreground' : 'text-muted-foreground hover:bg-accent')}
					aria-pressed={current === t.value}
				>
					<t.icon class="size-3.5" />{t.label}
				</button>
			{/each}
		</div>
		<div class="my-1.5 border-t"></div>
		<form method="POST" action="/logout">
			<button type="submit" class={cn(item, 'text-muted-foreground')}><LogOut class="size-4" /> Se déconnecter</button>
		</form>
	</Popover.Content>
</Popover.Root>

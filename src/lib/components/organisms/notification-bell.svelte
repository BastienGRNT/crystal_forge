<script lang="ts" module>
	export type NotificationItem = {
		id: number;
		ts: number;
		kind: 'job' | 'uptime' | 'backup';
		level: 'info' | 'success' | 'warn' | 'error';
		title: string;
		body: string | null;
		href: string | null;
	};
</script>

<script lang="ts">
	import { invalidate } from '$app/navigation';
	import Bell from '@lucide/svelte/icons/bell';
	import BellOff from '@lucide/svelte/icons/bell-off';
	import Rocket from '@lucide/svelte/icons/rocket';
	import Globe from '@lucide/svelte/icons/globe';
	import Archive from '@lucide/svelte/icons/archive';
	import * as Popover from '$lib/components/atoms/ui/popover';
	import { Button } from '$lib/components/atoms/ui/button';
	import RelativeTime from '$lib/components/molecules/relative-time.svelte';
	import { cn } from '$lib/utils';

	let { items, unread, seenAt }: { items: NotificationItem[]; unread: number; seenAt: number } = $props();

	let open = $state(false);
	// Ce qui était non lu à l'ouverture reste surligné tant que le menu est ouvert.
	let highlightBefore = $state(0);
	const ICONS = { job: Rocket, uptime: Globe, backup: Archive };
	const TONE = { info: 'text-info', success: 'text-success', warn: 'text-warning', error: 'text-danger' };

	async function markSeen() {
		highlightBefore = seenAt;
		if (!unread) return;
		await fetch('/api/notifications/seen', { method: 'POST' }).catch(() => null);
		void invalidate('forge:shell');
	}
</script>

<Popover.Root
	bind:open
	onOpenChange={(o) => {
		if (o) void markSeen();
	}}
>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="ghost" size="icon-sm" class="relative text-muted-foreground" aria-label={unread ? `Notifications (${unread} non lues)` : 'Notifications'}>
				<Bell />
				{#if unread}
					<span class="absolute top-1 right-1 grid min-w-3.5 place-items-center rounded-full bg-ember px-0.5 font-mono text-[9px] leading-3.5 font-bold text-ember-foreground shadow-[0_0_8px_var(--ember)]">{unread > 9 ? '9+' : unread}</span>
				{/if}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="end" class="w-96 p-0">
		<div class="flex items-center justify-between border-b px-3 py-2.5">
			<p class="text-sm font-medium">Notifications</p>
			<span class="text-[11px] text-muted-foreground">30 derniers jours</span>
		</div>
		{#if items.length === 0}
			<p class="flex flex-col items-center gap-2 px-3 py-8 text-center text-sm text-muted-foreground"><BellOff class="size-5 opacity-60" /> Rien à signaler pour l'instant.</p>
		{:else}
			<ul class="scrollbar-thin max-h-[420px] divide-y overflow-y-auto">
				{#each items as n (n.id)}
					{@const Icon = ICONS[n.kind]}
					{@const fresh = n.ts > highlightBefore}
					<li>
						<svelte:element
							this={n.href ? 'a' : 'div'}
							href={n.href ?? undefined}
							onclick={() => (open = false)}
							role={n.href ? undefined : 'listitem'}
							class={cn('flex items-start gap-2.5 px-3 py-2.5', n.href && 'hover:bg-accent/50', fresh && 'bg-ember/[0.04]')}
						>
							<span class={cn('mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-foreground/[0.05]', TONE[n.level])}><Icon class="size-3.5" /></span>
							<span class="min-w-0 flex-1">
								<span class="flex items-baseline gap-2">
									<span class="min-w-0 flex-1 truncate text-[13px] font-medium">{n.title}</span>
									{#if fresh}<span class="size-1.5 shrink-0 rounded-full bg-ember"></span>{/if}
								</span>
								{#if n.body}<span class="line-clamp-2 block text-xs text-muted-foreground">{n.body}</span>{/if}
								<span class="mt-0.5 block text-[11px] text-muted-foreground/70"><RelativeTime value={n.ts} /></span>
							</span>
						</svelte:element>
					</li>
				{/each}
			</ul>
		{/if}
	</Popover.Content>
</Popover.Root>

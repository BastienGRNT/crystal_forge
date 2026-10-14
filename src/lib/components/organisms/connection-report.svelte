<script lang="ts">
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import CircleMinus from '@lucide/svelte/icons/circle-minus';
	import Lock from '@lucide/svelte/icons/lock';
	import PencilLine from '@lucide/svelte/icons/pencil-line';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import ShieldX from '@lucide/svelte/icons/shield-x';
	import StatusBadge from '$lib/components/molecules/status-badge.svelte';
	import { cn } from '$lib/utils';
	import type { CheckSection, PermissionRow } from '$server/application/use-cases/connections';

	let { sections, permissions }: { sections: CheckSection[]; permissions: PermissionRow[] } = $props();
	const leaks = $derived(permissions.filter((p) => !p.ok));
</script>

{#snippet icon(status: string)}
	{#if status === 'ok'}<CircleCheck class="size-4 shrink-0 text-success" />
	{:else if status === 'error'}<CircleX class="size-4 shrink-0 text-danger" />
	{:else if status === 'warn'}<TriangleAlert class="size-4 shrink-0 text-warning" />
	{:else}<CircleMinus class="size-4 shrink-0 text-muted-foreground" />{/if}
{/snippet}

<div class="space-y-6">
	<div class="grid gap-4 md:grid-cols-2">
		{#each sections as s (s.id)}
			<div class={cn('rounded-xl border bg-card', s.status === 'error' && 'border-danger/40', s.status === 'warn' && 'border-warning/40')}>
				<div class="flex items-center justify-between gap-3 border-b px-4 py-3">
					<div class="flex items-center gap-2">
						{@render icon(s.status)}
						<span class="text-sm font-semibold">{s.label}</span>
					</div>
					<span class="text-xs text-muted-foreground">{s.summary} · {s.ms} ms</span>
				</div>
				<ul class="divide-y">
					{#each s.items as item, i (i)}
						<li class="flex items-start gap-2.5 px-4 py-2 text-sm">
							<span class="mt-0.5">{@render icon(item.status)}</span>
							<span class="w-36 shrink-0 text-muted-foreground">{item.label}</span>
							<span class="min-w-0 break-words">{item.detail}</span>
						</li>
					{/each}
				</ul>
			</div>
		{/each}
	</div>

	{#if permissions.length}
		<div class={cn('overflow-hidden rounded-xl border', leaks.length ? 'border-danger/50' : 'border-success/40')}>
			<div class={cn('flex items-center gap-3 px-4 py-3', leaks.length ? 'bg-danger/10' : 'bg-success/10')}>
				{#if leaks.length}<ShieldX class="size-5 text-danger" />{:else}<ShieldCheck class="size-5 text-success" />{/if}
				<div>
					<p class="text-sm font-semibold">{leaks.length ? 'Permissions dangereuses détectées' : 'La production est hors de portée de Forge'}</p>
					<p class="text-xs text-muted-foreground">Droits effectifs du jeton Proxmox sur chaque CT (GET /access/permissions).</p>
				</div>
			</div>
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="bg-muted/40 text-xs text-muted-foreground">
						<tr>
							<th class="px-4 py-2 text-left font-medium">CT</th>
							<th class="px-3 py-2 text-left font-medium">Pool</th>
							<th class="px-3 py-2 text-left font-medium">Attendu</th>
							<th class="px-3 py-2 text-left font-medium">Écriture possible</th>
							<th class="px-4 py-2 text-right font-medium">Verdict</th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each permissions as p (p.vmid)}
							<tr class={cn(!p.ok && 'bg-danger/5')}>
								<td class="px-4 py-2"><span class="font-mono">{p.vmid}</span> <span class="text-muted-foreground">{p.name}</span></td>
								<td class="px-3 py-2 font-mono text-xs">{p.pool ?? '—'}</td>
								<td class="px-3 py-2 text-xs">
									{#if p.expected === 'read'}<span class="inline-flex items-center gap-1 text-muted-foreground"><Lock class="size-3" /> lecture seule</span>
									{:else}<span class="inline-flex items-center gap-1 text-ember"><PencilLine class="size-3" /> géré par Forge</span>{/if}
								</td>
								<td class="px-3 py-2 text-xs">
									{#if p.canWrite}<span class="text-ember">oui</span>{:else}<span class="text-muted-foreground">non</span>{/if}
									<span class="ml-1 text-muted-foreground" title={p.privileges.join(', ')}>({p.privileges.length} privilèges)</span>
								</td>
								<td class="px-4 py-2 text-right"><StatusBadge status={p.ok ? 'ok' : 'error'} /></td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</div>

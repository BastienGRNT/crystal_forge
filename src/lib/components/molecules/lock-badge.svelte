<script lang="ts">
	import Lock from '@lucide/svelte/icons/lock';
	import * as Tooltip from '$lib/components/atoms/ui/tooltip';

	let { reason = 'Hors du pool forge : lecture seule. Forge n’a pas les droits Proxmox pour modifier ce CT.' }: { reason?: string } = $props();
</script>

<Tooltip.Root>
	<Tooltip.Trigger class="inline-flex h-5.5 items-center gap-1 rounded-full bg-muted px-2 text-xs font-medium text-muted-foreground ring-1 ring-border ring-inset">
		<Lock class="size-3" />
		Lecture seule
	</Tooltip.Trigger>
	<Tooltip.Content class="max-w-64">{reason}</Tooltip.Content>
</Tooltip.Root>

<script lang="ts">
	import Cpu from '@lucide/svelte/icons/cpu';
	import MemoryStick from '@lucide/svelte/icons/memory-stick';
	import HardDrive from '@lucide/svelte/icons/hard-drive';
	import Server from '@lucide/svelte/icons/server';
	import StatMeter from '$lib/components/molecules/stat-meter.svelte';
	import { bytes, percent, uptime } from '$lib/format';

	interface Host {
		cpu: number;
		cpus: number;
		memory: { total: number; used: number; free: number };
		rootfs: { total: number; used: number };
		uptime: number;
		loadavg: string[];
		pveversion: string;
		storage: { total: number; used: number; avail: number } | null;
	}
	let { host, node }: { host: Host; node: string } = $props();
	const memRatio = $derived(host.memory.used / host.memory.total);
	const disk = $derived(host.storage ?? { total: host.rootfs.total, used: host.rootfs.used, avail: host.rootfs.total - host.rootfs.used });
</script>

<section class="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 xl:grid-cols-4">
	<div class="flex flex-col justify-between gap-3 bg-card p-5">
		<div class="flex items-center gap-2 text-xs font-medium text-muted-foreground"><Server class="size-3.5" /> Hôte Proxmox</div>
		<div>
			<p class="font-mono text-lg font-semibold">{node}</p>
			<p class="mt-1 text-xs text-muted-foreground">{host.pveversion.split('/').slice(0, 2).join(' ')} · en marche depuis {uptime(host.uptime)}</p>
		</div>
		<p class="text-xs text-muted-foreground">Charge : <span class="font-mono text-foreground">{host.loadavg.join(' · ')}</span></p>
	</div>
	<div class="bg-card p-5">
		<StatMeter label="CPU" icon={Cpu} value={percent(host.cpu)} detail="sur {host.cpus} cœurs" ratio={host.cpu} />
	</div>
	<div class="bg-card p-5">
		<StatMeter
			label="Mémoire"
			icon={MemoryStick}
			value={bytes(host.memory.free)}
			detail="libres sur {bytes(host.memory.total)}"
			ratio={memRatio}
			hint={memRatio > 0.75 ? 'RAM serrée' : undefined}
		/>
	</div>
	<div class="bg-card p-5">
		<StatMeter label="Stockage local" icon={HardDrive} value={bytes(disk.avail)} detail="libres sur {bytes(disk.total)}" ratio={disk.used / disk.total} />
	</div>
</section>

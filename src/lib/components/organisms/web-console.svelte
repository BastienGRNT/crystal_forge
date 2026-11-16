<script lang="ts">
	import { tick } from 'svelte';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import Eraser from '@lucide/svelte/icons/eraser';
	import Lock from '@lucide/svelte/icons/lock';
	import { Button } from '$lib/components/atoms/ui/button';
	import ConfirmDialog from '$lib/components/molecules/confirm-dialog.svelte';
	import Spinner from '$lib/components/atoms/spinner.svelte';
	import { cn } from '$lib/utils';

	let { slug, ctid, dryRun = false }: { slug: string; ctid: number; dryRun?: boolean } = $props();

	type Entry = { cwd: string; command: string; output: string; code: number | null; error?: string };
	let unlocked = $state(false);
	let confirmOpen = $state(false);
	let entries = $state<Entry[]>([]);
	let cwd = $state('');
	let command = $state('');
	let busy = $state(false);
	let history: string[] = [];
	let hIndex = -1;
	let viewport: HTMLDivElement | undefined = $state();
	let input: HTMLInputElement | undefined = $state();

	async function run() {
		const c = command.trim();
		if (!c || busy) return;
		if (c === 'clear') {
			entries = [];
			command = '';
			return;
		}
		busy = true;
		history = [c, ...history.filter((h) => h !== c)].slice(0, 50);
		hIndex = -1;
		const shownCwd = cwd || '~';
		try {
			const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/console`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ command: c, cwd })
			});
			const body = (await res.json()) as { output?: string; code?: number | null; cwd?: string; error?: string };
			if (!res.ok || body.error) entries.push({ cwd: shownCwd, command: c, output: '', code: null, error: body.error ?? `Erreur ${res.status}` });
			else {
				entries.push({ cwd: shownCwd, command: c, output: body.output ?? '', code: body.code ?? null });
				cwd = body.cwd ?? cwd;
			}
		} catch (err) {
			entries.push({ cwd: shownCwd, command: c, output: '', code: null, error: String(err) });
		}
		command = '';
		busy = false;
		await tick();
		viewport?.scrollTo({ top: viewport.scrollHeight });
		input?.focus();
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			void run();
		} else if (e.key === 'ArrowUp' && history.length) {
			e.preventDefault();
			hIndex = Math.min(hIndex + 1, history.length - 1);
			command = history[hIndex] ?? '';
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			hIndex = Math.max(hIndex - 1, -1);
			command = hIndex < 0 ? '' : (history[hIndex] ?? '');
		} else if (e.key === 'l' && e.ctrlKey) {
			e.preventDefault();
			entries = [];
		}
	}
</script>

<section class="overflow-hidden rounded-lg border bg-[#0b0d10] text-white shadow-sm">
	<header class="flex items-center gap-2 border-b border-white/10 px-3 py-2">
		<span class="flex gap-1.5" aria-hidden="true">
			<span class="size-2.5 rounded-full bg-white/15"></span><span class="size-2.5 rounded-full bg-white/15"></span><span class="size-2.5 rounded-full bg-white/15"></span>
		</span>
		<SquareTerminal class="ml-1 size-3.5 text-white/60" />
		<p class="flex-1 truncate font-mono text-xs text-white/70">root@ct-{ctid} — console</p>
		{#if dryRun}<span class="rounded-sm bg-amber-400/15 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-amber-300 uppercase">dry-run</span>{/if}
		{#if unlocked}
			<Button variant="ghost" size="icon-sm" class="text-white/60 hover:bg-white/10 hover:text-white" onclick={() => (entries = [])} aria-label="Effacer" title="Effacer (Ctrl+L)"><Eraser /></Button>
		{/if}
	</header>

	{#if !unlocked}
		<div class="flex flex-col items-center gap-3 px-6 py-10 text-center">
			<Lock class="size-5 text-white/40" />
			<p class="max-w-md text-sm text-white/70">Commandes en <strong class="text-white">root</strong> dans le conteneur, une à la fois (pas de programme interactif : vim, top…). Chaque commande est journalisée ; les plus dangereuses sont refusées.</p>
			<Button size="sm" variant="outline" class="border-white/20 bg-transparent text-white hover:bg-white/10" onclick={() => (confirmOpen = true)}><SquareTerminal /> Ouvrir la console</Button>
		</div>
	{:else}
		<div bind:this={viewport} class="scrollbar-thin max-h-[28rem] min-h-48 overflow-y-auto px-3 py-2 font-mono text-[12.5px] leading-relaxed" role="log">
			{#if entries.length === 0}<p class="text-white/40"># Tapez une commande, Entrée pour lancer. ↑/↓ : historique. « clear » ou Ctrl+L : effacer.</p>{/if}
			{#each entries as e, i (i)}
				<p class="mt-1 break-all"><span class="text-emerald-400">{e.cwd}</span> <span class="text-white/40">#</span> {e.command}</p>
				{#if e.error}<p class="whitespace-pre-wrap text-red-400">{e.error}</p>{/if}
				{#if e.output}<pre class="whitespace-pre-wrap break-all text-white/85">{e.output}</pre>{/if}
				{#if e.code !== null && e.code !== 0}<p class="text-[11px] text-red-400/80">code de sortie {e.code}</p>{/if}
			{/each}
		</div>
		<label class="flex items-center gap-2 border-t border-white/10 px-3 py-2 font-mono text-[12.5px]">
			<span class="shrink-0 text-emerald-400">{cwd || '~'}</span><span class="text-white/40">#</span>
			<!-- svelte-ignore a11y_autofocus -->
			<input
				bind:this={input}
				bind:value={command}
				onkeydown={onKey}
				disabled={busy}
				autofocus
				autocomplete="off"
				spellcheck="false"
				aria-label="Commande"
				class={cn('min-w-0 flex-1 bg-transparent text-white outline-none placeholder:text-white/30', busy && 'opacity-60')}
				placeholder="docker compose ps"
			/>
			{#if busy}<Spinner class="size-3.5 text-white/60" />{/if}
		</label>
	{/if}
</section>

<ConfirmDialog
	bind:open={confirmOpen}
	title="Ouvrir une console root ?"
	description="Les commandes s'exécutent en root dans le conteneur de production du projet, sans retour en arrière possible. À utiliser pour un diagnostic ou une réparation ponctuelle."
	confirmLabel="Ouvrir la console"
	onConfirm={() => {
		unlocked = true;
		confirmOpen = false;
	}}
/>

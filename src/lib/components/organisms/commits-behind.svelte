<script lang="ts">
	/** « X commits en retard » : ce qui est poussé sur GitHub mais pas encore en ligne. */
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import Rocket from '@lucide/svelte/icons/rocket';
	import CheckCircle from '@lucide/svelte/icons/circle-check';
	import { Button } from '$lib/components/atoms/ui/button';
	import RelativeTime from '$lib/components/molecules/relative-time.svelte';

	let { slug, owner, repo, branch, canDeploy }: { slug: string; owner: string; repo: string; branch: string; canDeploy: boolean } = $props();

	type C = { sha: string; message: string; date: string | null; author: string | null };
	let data = $state<{ known: boolean; aheadBy: number; commits: C[]; error?: string } | null>(null);
	let busy = $state(false);
	$effect(() => {
		void slug;
		fetch(`/api/projects/${slug}/commits`)
			.then((r) => r.json())
			.then((j) => (data = j))
			.catch(() => (data = { known: false, aheadBy: 0, commits: [], error: 'GitHub injoignable' }));
	});
</script>

{#if data && data.known && !data.error}
	{#if data.aheadBy > 0}
		<section class="overflow-hidden rounded-lg border border-ember/30 bg-ember/[0.04]">
			<div class="flex flex-wrap items-center gap-3 border-b border-ember/20 px-4 py-2.5">
				<GitBranch class="size-4 text-ember" />
				<p class="flex-1 text-sm"><span class="font-semibold">{data.aheadBy} commit{data.aheadBy > 1 ? 's' : ''} en retard</span> <span class="text-muted-foreground">sur <span class="font-mono">{branch}</span> : poussé{data.aheadBy > 1 ? 's' : ''} mais pas encore en ligne.</span></p>
				{#if canDeploy}
					<form
						method="POST"
						action="/projects/{slug}/deployments?/redeploy"
						use:enhance={() => {
							busy = true;
							return async ({ result }) => {
								busy = false;
								if (result.type === 'redirect') void goto(result.location);
								else if (result.type === 'failure') toast.error((result.data as { error?: string })?.error ?? 'Échec');
							};
						}}
					>
						<Button type="submit" size="sm" disabled={busy}><Rocket /> Déployer maintenant</Button>
					</form>
				{/if}
			</div>
			<ul class="divide-y divide-ember/10">
				{#each data.commits as c (c.sha)}
					<li class="flex items-center gap-3 px-4 py-2 text-sm">
						<a href="https://github.com/{owner}/{repo}/commit/{c.sha}" target="_blank" rel="noreferrer" class="font-mono text-xs text-ember hover:underline">{c.sha.slice(0, 7)}</a>
						<span class="min-w-0 flex-1 truncate">{c.message.split('\n')[0]}</span>
						<span class="hidden shrink-0 text-xs text-muted-foreground sm:inline">{c.author ?? ''}{#if c.date} · <RelativeTime value={new Date(c.date).getTime()} />{/if}</span>
					</li>
				{/each}
				{#if data.aheadBy > data.commits.length}<li class="px-4 py-2 text-xs text-muted-foreground">… et {data.aheadBy - data.commits.length} de plus</li>{/if}
			</ul>
		</section>
	{:else}
		<p class="flex items-center gap-2 text-xs text-muted-foreground"><CheckCircle class="size-3.5 text-success" /> À jour : la version en ligne est le dernier commit de <span class="font-mono">{branch}</span>.</p>
	{/if}
{/if}

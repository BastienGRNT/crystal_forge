<script lang="ts">
	import { cn } from '$lib/utils';
	import { TONE_BG, TONE_TEXT, type Tone } from '$lib/status';

	let { tone = 'neutral', pulse = false, class: className = '' }: { tone?: Tone; pulse?: boolean; class?: string } = $props();
</script>

<!-- Pastille d'état : lueur de sa couleur en sombre, anneau qui pulse quand l'état est transitoire. -->
<span
	class={cn('relative inline-flex size-2 shrink-0 rounded-full', TONE_BG[tone], tone !== 'neutral' && ['glow', TONE_TEXT[tone]], pulse && ['animate-pulse-ring', TONE_TEXT[tone]], className)}
	aria-hidden="true"
></span>

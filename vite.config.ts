import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	optimizeDeps: {
		// Les icônes lucide sont importées une par une : on les sert sans pré-bundling
		// pour éviter les rechargements « optimized dependencies changed » en dev.
		exclude: ['@lucide/svelte']
	},
	ssr: {
		external: ['better-sqlite3', 'ssh2', '@node-rs/argon2']
	},
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});

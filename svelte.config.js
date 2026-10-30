import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	compilerOptions: { runes: true },
	kit: {
		adapter: adapter({ out: 'build' }),
		// Contrôle d'origine fait dans hooks.server.ts (compare Origin et Host, sans ORIGIN figé).
		csrf: { trustedOrigins: ['*'] },
		alias: {
			'$server': 'src/lib/server'
		}
	}
};

export default config;

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	schema: './src/lib/server/infrastructure/db/schema.ts',
	out: './drizzle',
	dialect: 'sqlite',
	dbCredentials: { url: process.env.DATABASE_PATH ?? './data/forge.db' },
	strict: true,
	verbose: true
});

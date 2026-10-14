import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema>;

export function openDatabase(path: string): { db: Db; sqlite: Database.Database } {
	if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
	const sqlite = new Database(path);
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('foreign_keys = ON');
	sqlite.pragma('busy_timeout = 5000');
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: process.env.FORGE_MIGRATIONS_DIR ?? resolve('drizzle') });
	return { db, sqlite };
}

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './client';

/** Copie des migrations jusqu'à 0002 incluse (état d'une installation antérieure). */
function migrationsUpTo0002(): string {
	const dir = mkdtempSync(join(tmpdir(), 'forge-mig-'));
	const src = resolve('drizzle');
	mkdirSync(join(dir, 'meta'));
	for (const f of readdirSync(src).filter((f) => /^000[0-2]_/.test(f))) copyFileSync(join(src, f), join(dir, f));
	for (const f of readdirSync(join(src, 'meta')).filter((f) => /^000[0-2]_/.test(f))) copyFileSync(join(src, 'meta', f), join(dir, 'meta', f));
	const journal = JSON.parse(readFileSync(join(src, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number }[] };
	journal.entries = journal.entries.filter((e) => e.idx <= 2);
	writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
	return dir;
}

function settingsOf(path: string): Record<string, string> {
	const db = new Database(path, { readonly: true });
	const rows = db.prepare('select key, value from settings').all() as { key: string; value: string }[];
	db.close();
	return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

describe('migration 0003 (anciens réglages par défaut)', () => {
	it('fige les anciennes valeurs sur une installation existante, sans écraser un réglage saisi', () => {
		const path = join(mkdtempSync(join(tmpdir(), 'forge-db-')), 'forge.db');
		const sqlite = new Database(path);
		migrate(drizzle(sqlite), { migrationsFolder: migrationsUpTo0002() });
		sqlite.prepare("insert into admin (id, password_hash) values (1, 'x')").run();
		sqlite.prepare("insert into settings (key, value, is_secret) values ('github.owner', 'quelquun', 0)").run();
		sqlite.close();

		openDatabase(path).sqlite.close();
		const s = settingsOf(path);
		expect(s['network.publicIp']).toBe('51.68.180.212');
		expect(s['safety.protectedCtids']).toBe('100,101,401,402,403,404');
		expect(s['github.owner']).toBe('quelquun');
	});

	it("n'insère rien sur une installation neuve", () => {
		const path = join(mkdtempSync(join(tmpdir(), 'forge-db-')), 'forge.db');
		openDatabase(path).sqlite.close();
		expect(settingsOf(path)).toEqual({});
	});
});

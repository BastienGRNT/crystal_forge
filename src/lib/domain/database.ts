/**
 * Bases de données des projets (PostgreSQL, MySQL, MariaDB) : scripts exécutés DANS le
 * conteneur de la base (identifiants lus dans son propre environnement, jamais par Forge),
 * règles de sécurité des requêtes SQL et lecture des résultats.
 */
import { SafetyViolation } from './errors';
import type { SqlDbKind } from './compose-analysis';

/** Dossier des sauvegardes sur le CT (propriété de l'utilisateur github du runner). */
export const BACKUP_ROOT = '/home/github/forge-backups';
/** Nombre de sauvegardes « pre-deploy » conservées par le workflow. */
export const PRE_DEPLOY_KEEP = 10;
/** Taille maximale d'un dump téléchargé depuis l'interface. */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_RESULT_BYTES = 2_000_000;

export type BackupReason = 'manual' | 'pre-deploy' | 'pre-restore' | 'pre-query' | 'import';
const BACKUP_NAME_RE = /^\d{8}-\d{6}-(manual|pre-deploy|pre-restore|pre-query|import)(-[0-9a-f]{7,40})?\.sql\.gz$/;
/** Taille maximale d'un dump importé depuis le navigateur. */
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

export function isValidBackupName(name: string): boolean {
	return BACKUP_NAME_RE.test(name);
}

export function backupName(reason: BackupReason, now = new Date(), suffix?: string): string {
	const p = (n: number) => String(n).padStart(2, '0');
	const ts = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
	return `${ts}-${reason}${suffix && /^[0-9a-f]{7,40}$/.test(suffix) ? `-${suffix}` : ''}.sql.gz`;
}

export function parseBackupName(name: string): { reason: BackupReason; at: number } | null {
	const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-([a-z-]+?)(?:-[0-9a-f]{7,40})?\.sql\.gz$/.exec(name);
	if (!m || !isValidBackupName(name)) return null;
	const [, y, mo, d, h, mi, s, reason] = m;
	return { reason: reason as BackupReason, at: Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!) };
}

// --- Scripts exécutés dans le conteneur de la base ----------------------------------------

/** Variables d'identification, résolues dans le conteneur à partir de son environnement. */
const PG_ENV = 'U="${POSTGRES_USER:-postgres}"; D="${POSTGRES_DB:-$U}";';
const MY_ENV =
	'U=root; P="${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}"; ' +
	'if [ -z "$P" ]; then U="${MARIADB_USER:-$MYSQL_USER}"; P="${MARIADB_PASSWORD:-$MYSQL_PASSWORD}"; fi; ' +
	'D="${MARIADB_DATABASE:-$MYSQL_DATABASE}"; export MYSQL_PWD="$P"; ' +
	'C="$(command -v mariadb || command -v mysql)";';

/** Script qui écrit un dump SQL sur la sortie standard. */
export function dumpScript(kind: SqlDbKind): string {
	if (kind === 'postgres') return `${PG_ENV} exec pg_dump -U "$U" --clean --if-exists --no-owner --no-privileges "$D"`;
	return `${MY_ENV} DUMP="$(command -v mariadb-dump || command -v mysqldump)"; exec "$DUMP" -u"$U" --single-transaction --routines --triggers --add-drop-table "$D"`;
}

/** Script qui rejoue un dump lu sur l'entrée standard. */
export function restoreScript(kind: SqlDbKind): string {
	if (kind === 'postgres') return `${PG_ENV} exec psql -X -q -v ON_ERROR_STOP=1 -U "$U" -d "$D"`;
	return `${MY_ENV} exec "$C" -u"$U" "$D"`;
}

/**
 * Script qui exécute la requête lue sur l'entrée standard.
 * PostgreSQL : `psql -c "$(cat)"` (jamais de méta-commande), sortie CSV, et en lecture
 * seule `default_transaction_read_only=on`. MySQL/MariaDB : transaction READ ONLY.
 */
export function queryScript(kind: SqlDbKind, readOnly: boolean): string {
	if (kind === 'postgres') {
		const opts = readOnly ? '-c default_transaction_read_only=on -c statement_timeout=15000' : '-c statement_timeout=120000';
		return `${PG_ENV} PGOPTIONS="${opts}" exec psql -X -q -v ON_ERROR_STOP=1 --csv -U "$U" -d "$D" -c "$(cat)"`;
	}
	const wrap = readOnly
		? `"SET SESSION TRANSACTION READ ONLY; START TRANSACTION READ ONLY; $(cat); ROLLBACK;"`
		: `"$(cat)"`;
	return `${MY_ENV} exec "$C" -u"$U" --batch -D "$D" -e ${wrap}`;
}

/** Informations sur la base (version, nom, utilisateur, taille). Une ligne CSV/TSV. */
export function infoSql(kind: SqlDbKind): string {
	if (kind === 'postgres') {
		return `SELECT current_setting('server_version') AS version, current_database() AS database, current_user AS "user", pg_database_size(current_database()) AS bytes`;
	}
	return `SELECT VERSION() AS version, DATABASE() AS \`database\`, CURRENT_USER() AS \`user\`, (SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = DATABASE()) AS bytes`;
}

export function tablesSql(kind: SqlDbKind): string {
	if (kind === 'postgres') {
		return `SELECT n.nspname AS schema, c.relname AS name, GREATEST(c.reltuples, 0)::bigint AS rows, pg_total_relation_size(c.oid) AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' ORDER BY 1, 2`;
	}
	return `SELECT table_schema AS \`schema\`, table_name AS name, COALESCE(table_rows, 0) AS \`rows\`, COALESCE(data_length + index_length, 0) AS bytes FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY 2`;
}

const IDENT_RE = /^[A-Za-z0-9_$\- ]{1,63}$/;

export function quoteIdent(kind: SqlDbKind, name: string): string {
	if (!IDENT_RE.test(name)) throw new SafetyViolation('sql.ident', `Nom de table invalide : ${name}`);
	return kind === 'postgres' ? `"${name.replace(/"/g, '""')}"` : `\`${name.replace(/`/g, '``')}\``;
}

export function browseSql(kind: SqlDbKind, schema: string, table: string, limit: number, offset: number): string {
	const l = Math.min(Math.max(Math.trunc(limit), 1), 500);
	const o = Math.max(Math.trunc(offset), 0);
	return `SELECT * FROM ${quoteIdent(kind, schema)}.${quoteIdent(kind, table)} LIMIT ${l} OFFSET ${o}`;
}

// --- Règles de sécurité des requêtes -------------------------------------------------------

/** Retire chaînes, identifiants entre guillemets et commentaires (pour analyser les mots-clés). */
export function stripSqlLiterals(sql: string, kind: SqlDbKind): string {
	let out = '';
	let i = 0;
	while (i < sql.length) {
		const c = sql[i] as string;
		const next = sql[i + 1];
		if (c === '-' && next === '-') {
			while (i < sql.length && sql[i] !== '\n') i++;
			out += ' ';
			continue;
		}
		if (c === '#' && kind !== 'postgres') {
			while (i < sql.length && sql[i] !== '\n') i++;
			out += ' ';
			continue;
		}
		if (c === '/' && next === '*') {
			const end = sql.indexOf('*/', i + 2);
			i = end < 0 ? sql.length : end + 2;
			out += ' ';
			continue;
		}
		if (kind === 'postgres' && c === '$') {
			const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
			if (tag) {
				const end = sql.indexOf(tag, i + tag.length);
				i = end < 0 ? sql.length : end + tag.length;
				out += " '' ";
				continue;
			}
		}
		if (c === "'" || c === '"' || (c === '`' && kind !== 'postgres')) {
			let j = i + 1;
			while (j < sql.length) {
				if (sql[j] === '\\' && kind !== 'postgres') {
					j += 2;
					continue;
				}
				if (sql[j] === c) {
					if (sql[j + 1] === c) {
						j += 2;
						continue;
					}
					break;
				}
				j++;
			}
			i = j + 1;
			out += c === "'" ? " '' " : ' ident ';
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

/** Instructions acceptées en lecture seule (premier mot de chaque instruction). */
const READ_STARTS = new Set(['select', 'with', 'values', 'table', 'show', 'explain', 'describe', 'desc']);
/** Fonctions / mots interdits en lecture seule (sortie de transaction, fichiers, shell…). */
const READ_FORBIDDEN = [
	'set_config',
	'program',
	'copy',
	'lo_import',
	'lo_export',
	'pg_terminate_backend',
	'pg_cancel_backend',
	'pg_reload_conf',
	'dblink',
	'dblink_exec',
	'outfile',
	'dumpfile',
	'load_file',
	'commit',
	'rollback'
];
/** Interdits même en écriture : exécutent une commande dans le conteneur. */
const ALWAYS_FORBIDDEN = ['program'];
/** Commandes du client mysql reconnues en début d'instruction. */
const MYSQL_CLIENT_COMMANDS = new Set(['system', 'source', 'pager', 'nopager', 'tee', 'notee', 'edit', 'connect', 'delimiter', 'charset', 'prompt', 'rehash', 'resetconnection', 'query_attributes', 'ego', 'go', 'print', 'exit', 'quit']);

const DESTRUCTIVE: [RegExp, string][] = [
	[/\bdrop\s+(database|schema)\b/, 'DROP DATABASE/SCHEMA'],
	[/\bdrop\s+(table|view|materialized\s+view|index|type|function|sequence|extension)\b/, 'DROP'],
	[/\btruncate\b/, 'TRUNCATE'],
	[/\balter\s+table\b[^;]*\bdrop\b/, 'ALTER TABLE … DROP'],
	[/\bdelete\s+from\b(?![^;]*\bwhere\b)/, 'DELETE sans WHERE'],
	[/\bupdate\b(?![^;]*\bwhere\b)[^;]*\bset\b/, 'UPDATE sans WHERE']
];

export interface SqlAnalysis {
	statements: string[];
	/** Accepté en lecture seule. */
	readOnly: boolean;
	/** Opérations destructrices repérées (confirmation + sauvegarde automatique). */
	destructive: string[];
}

export const MAX_SQL_LENGTH = 100_000;

/** Analyse une requête saisie dans la console ; lève SafetyViolation si elle est interdite. */
export function analyzeSql(sql: string, kind: SqlDbKind, readOnlyMode: boolean): SqlAnalysis {
	if (sql.trim() === '') throw new SafetyViolation('sql.empty', 'Requête vide.');
	if (sql.length > MAX_SQL_LENGTH) throw new SafetyViolation('sql.size', 'Requête trop longue (100 000 caractères max).');
	const stripped = stripSqlLiterals(sql, kind).toLowerCase();
	// Méta-commandes du client (psql « \! », mysql « \! » / « system ») : shell dans le conteneur.
	if (/\\/.test(stripped)) throw new SafetyViolation('sql.meta', 'Les méta-commandes du client (\\…) ne sont pas autorisées.');

	const statements = stripped
		.split(';')
		.map((s) => s.trim())
		.filter((s) => s !== '');
	if (statements.length === 0) throw new SafetyViolation('sql.empty', 'Requête vide.');

	for (const st of statements) {
		const first = /^[a-z_]+/.exec(st)?.[0] ?? '';
		if (kind !== 'postgres' && MYSQL_CLIENT_COMMANDS.has(first)) {
			throw new SafetyViolation('sql.meta', `Commande du client « ${first} » non autorisée.`);
		}
	}
	const words = new Set(stripped.match(/[a-z_][a-z0-9_]*/g) ?? []);
	for (const w of ALWAYS_FORBIDDEN) {
		if (words.has(w)) throw new SafetyViolation('sql.forbidden', `« ${w.toUpperCase()} » est interdit (exécution de commande dans le conteneur).`);
	}

	const readOnly = statements.every((st) => READ_STARTS.has(/^[a-z_]+/.exec(st)?.[0] ?? '')) && !READ_FORBIDDEN.some((w) => words.has(w));
	if (readOnlyMode && !readOnly) {
		throw new SafetyViolation(
			'sql.read-only',
			'Mode lecture seule : seules les requêtes SELECT / WITH / SHOW / EXPLAIN sont acceptées. Passez en mode écriture pour modifier les données.'
		);
	}
	const destructive = [...new Set(statements.flatMap((st) => DESTRUCTIVE.filter(([re]) => re.test(st)).map(([, label]) => label)))];
	return { statements, readOnly, destructive };
}

// --- Lecture des résultats -----------------------------------------------------------------

export interface QueryResult {
	columns: string[];
	rows: string[][];
	truncated: boolean;
}

/** CSV de psql --csv (RFC 4180). */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else quoted = false;
			} else field += c;
			continue;
		}
		if (c === '"') quoted = true;
		else if (c === ',') {
			row.push(field);
			field = '';
		} else if (c === '\n') {
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else if (c !== '\r') field += c;
	}
	if (field !== '' || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

/** Sortie --batch du client mysql : TSV avec \t \n \\ échappés. */
export function parseMysqlBatch(text: string): string[][] {
	const unescape = (s: string) => s.replace(/\\(.)/g, (_, c: string) => (c === 't' ? '\t' : c === 'n' ? '\n' : c === '0' ? '\0' : c));
	return text
		.split('\n')
		.filter((l) => l !== '')
		.map((l) => l.split('\t').map(unescape));
}

export function parseQueryOutput(kind: SqlDbKind, stdout: string, truncated = false): QueryResult {
	const rows = kind === 'postgres' ? parseCsv(stdout) : parseMysqlBatch(stdout);
	const [columns = [], ...data] = rows;
	return { columns, rows: data, truncated };
}

// --- Workflow : sauvegarde avant déploiement ---------------------------------------------

/**
 * Script bash du workflow : dump de la base avant `docker compose up`, si le service
 * tourne déjà (pas au premier déploiement). Conserve les PRE_DEPLOY_KEEP derniers.
 */
export function workflowBackupScript(slug: string): string {
	const dir = `${BACKUP_ROOT}/${slug}`;
	return `set -euo pipefail
cd "\${FORGE_WORKDIR:-.}"
if [ -z "$(docker compose -f "$FORGE_COMPOSE_FILE" ps --status running -q "$FORGE_DB_SERVICE" 2>/dev/null)" ]; then
  echo "Base « $FORGE_DB_SERVICE » pas encore démarrée : rien à sauvegarder."
  exit 0
fi
case "$FORGE_DB_KIND" in
  postgres) SCRIPT='${dumpScript('postgres')}' ;;
  mysql|mariadb) SCRIPT='${dumpScript('mysql')}' ;;
  *) echo "Type de base « $FORGE_DB_KIND » non pris en charge : sauvegarde ignorée."; exit 0 ;;
esac
mkdir -p "${dir}"
umask 077
FILE="${dir}/$(date -u +%Y%m%d-%H%M%S)-pre-deploy-\${GITHUB_SHA::7}.sql.gz"
docker compose -f "$FORGE_COMPOSE_FILE" exec -T "$FORGE_DB_SERVICE" sh -c "$SCRIPT" | gzip > "$FILE.part"
mv "$FILE.part" "$FILE"
echo "Sauvegarde : $FILE ($(du -h "$FILE" | cut -f1))"
ls -1t "${dir}"/*-pre-deploy-*.sql.gz 2>/dev/null | tail -n +${PRE_DEPLOY_KEEP + 1} | xargs -r rm -f --`;
}

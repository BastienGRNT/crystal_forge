/**
 * Lecture d'un docker-compose : services, bases de données, migrations gérées par
 * compose (service « one-shot » attendu via service_completed_successfully).
 */
import { parse as parseYaml } from 'yaml';
import { composeEnvRefs, type ComposeEnvRef } from './env-template';

export type DbKind = 'postgres' | 'mysql' | 'mariadb' | 'redis' | 'mongo';
/** Bases gérées par l'onglet « Base de données » (console, dumps). */
export const SQL_DB_KINDS = ['postgres', 'mysql', 'mariadb'] as const;
export type SqlDbKind = (typeof SQL_DB_KINDS)[number];

export const DB_LABEL: Record<DbKind, string> = {
	postgres: 'PostgreSQL',
	mysql: 'MySQL',
	mariadb: 'MariaDB',
	redis: 'Redis',
	mongo: 'MongoDB'
};

export interface ComposeService {
	name: string;
	image: string | null;
	build: boolean;
	dependsOn: { service: string; condition: string }[];
	ports: string[];
	hasHealthcheck: boolean;
	restart: string | null;
	db: DbKind | null;
}

export interface ComposeAnalysis {
	services: ComposeService[];
	databases: { service: string; kind: DbKind }[];
	/** Services one-shot dont dépend un autre service avec service_completed_successfully. */
	migrationServices: { service: string; requiredBy: string[] }[];
	envRefs: ComposeEnvRef[];
	error: string | null;
}

export function detectDbKind(image: string | null): DbKind | null {
	if (!image) return null;
	const name = (image.split('@')[0] ?? '').split(':')[0]?.split('/').pop()?.toLowerCase() ?? '';
	if (/^(postgres|postgis|timescaledb(-ha)?|pgvector|postgresql)$/.test(name)) return 'postgres';
	if (name === 'mariadb') return 'mariadb';
	if (/^(mysql|mysql-server|percona(-server)?)$/.test(name)) return 'mysql';
	if (/^(redis|valkey|redis-stack(-server)?|keydb)$/.test(name)) return 'redis';
	if (/^mongo(db)?$/.test(name)) return 'mongo';
	return null;
}

function dependsOnList(raw: unknown): { service: string; condition: string }[] {
	if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string').map((service) => ({ service, condition: 'service_started' }));
	if (raw && typeof raw === 'object') {
		return Object.entries(raw as Record<string, { condition?: string } | null>).map(([service, v]) => ({
			service,
			condition: v?.condition ?? 'service_started'
		}));
	}
	return [];
}

export function analyzeCompose(content: string): ComposeAnalysis {
	const empty: ComposeAnalysis = { services: [], databases: [], migrationServices: [], envRefs: [], error: null };
	let doc: unknown;
	try {
		doc = parseYaml(content);
	} catch (err) {
		return { ...empty, error: err instanceof Error ? err.message : String(err) };
	}
	const raw = (doc as { services?: Record<string, Record<string, unknown> | null> } | null)?.services;
	if (!raw || typeof raw !== 'object') return { ...empty, envRefs: composeEnvRefs(content), error: 'Aucune section « services »' };

	const services: ComposeService[] = Object.entries(raw).map(([name, s]) => {
		const image = typeof s?.image === 'string' ? s.image : null;
		return {
			name,
			image,
			build: s?.build !== undefined,
			dependsOn: dependsOnList(s?.depends_on),
			ports: Array.isArray(s?.ports) ? s.ports.map((p) => (typeof p === 'object' ? JSON.stringify(p) : String(p))) : [],
			hasHealthcheck: !!s?.healthcheck,
			restart: typeof s?.restart === 'string' ? s.restart : null,
			db: detectDbKind(image)
		};
	});

	const required = new Map<string, string[]>();
	for (const s of services) {
		for (const d of s.dependsOn) {
			if (d.condition === 'service_completed_successfully') required.set(d.service, [...(required.get(d.service) ?? []), s.name]);
		}
	}
	return {
		services,
		databases: services.filter((s) => s.db).map((s) => ({ service: s.name, kind: s.db as DbKind })),
		migrationServices: [...required].map(([service, requiredBy]) => ({ service, requiredBy })),
		envRefs: composeEnvRefs(content),
		error: null
	};
}

export function isSqlDbKind(kind: string | null | undefined): kind is SqlDbKind {
	return !!kind && (SQL_DB_KINDS as readonly string[]).includes(kind);
}

/** Exemple de service de migration à ajouter au compose (affiché dans l'assistant). */
export function migrationSnippet(appService: string, dbService: string | null, command = 'npx drizzle-kit migrate'): string {
	const dep = dbService ? `\n    depends_on:\n      ${dbService}:\n        condition: service_healthy` : '';
	return `services:
  migrate:
    build: .
    env_file: .env
    command: ${command}
    restart: "no"${dep}

  ${appService}:
    # … configuration existante …
    depends_on:
      migrate:
        condition: service_completed_successfully`;
}

/**
 * Analyse d'un `.env.example` (ou équivalent) pour préremplir le .env d'un projet :
 * clés, valeurs par défaut, commentaires, et valeurs déduites (domaine, port, secrets).
 */
import { parseEnv } from './env-file';

export const ENV_TEMPLATE_FILES = ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults', 'example.env'] as const;

export type EnvVarKind = 'secret' | 'url' | 'port' | 'plain';

export interface EnvTemplateEntry {
	key: string;
	/** Valeur par défaut du modèle ('' si absente). */
	defaultValue: string;
	/** Commentaire qui précède la ligne (ou commentaire de fin de ligne). */
	comment: string | null;
	kind: EnvVarKind;
}

export interface EnvTemplate {
	file: string;
	entries: EnvTemplateEntry[];
}

const SECRET_RE = /(SECRET|PASSWORD|PASSWD|PASS|_KEY|TOKEN|SALT|PRIVATE|CREDENTIAL|SIGNING|ENCRYPTION)(_|$)/i;
const URL_RE = /^(ORIGIN|PUBLIC_URL|APP_URL|BASE_URL|SITE_URL|NEXTAUTH_URL|AUTH_URL|PUBLIC_ORIGIN|PUBLIC_BASE_URL|VITE_APP_URL|FRONTEND_URL|HOST_URL)$/i;
const PORT_RE = /^(PORT|APP_PORT|HTTP_PORT|SERVER_PORT)$/i;
/** Valeurs d'exemple qu'il faut remplacer. */
const PLACEHOLDER_RE = /^(changeme|change[-_]?me|xxx+|your[-_].*|<.*>|todo|replace[-_]?me|secret|password|example|\*+)$/i;

export function classifyEnvKey(key: string): EnvVarKind {
	if (URL_RE.test(key)) return 'url';
	if (PORT_RE.test(key)) return 'port';
	// Les URL de connexion (DATABASE_URL…) contiennent un mot de passe mais ne se génèrent pas.
	if (/_URL$|_URI$|_DSN$|_HOST$|_USER(NAME)?$|_NAME$|_DB$/i.test(key)) return 'plain';
	if (SECRET_RE.test(key)) return 'secret';
	return 'plain';
}

export function isPlaceholder(value: string): boolean {
	return value.trim() === '' || PLACEHOLDER_RE.test(value.trim());
}

export function parseEnvTemplate(file: string, text: string): EnvTemplate {
	const parsed = parseEnv(text);
	const lines = parsed.normalized.split('\n');
	const entries = parsed.entries.map((e): EnvTemplateEntry => {
		// Bloc de commentaires juste au-dessus (sans ligne vide entre les deux).
		const above: string[] = [];
		for (let i = e.line - 2; i >= 0; i--) {
			const l = (lines[i] ?? '').trim();
			if (!l.startsWith('#')) break;
			above.unshift(l.replace(/^#+\s?/, ''));
		}
		const inline = /\s#\s?(.+)$/.exec(lines[e.line - 1] ?? '')?.[1];
		const comment = (above.length ? above.join(' ') : inline ?? '').trim() || null;
		return { key: e.key, defaultValue: e.value, comment, kind: classifyEnvKey(e.key) };
	});
	return { file, entries };
}

/** Variables référencées par un docker-compose : ${VAR}, ${VAR:-défaut}, ${VAR:?erreur}, $VAR. */
export interface ComposeEnvRef {
	key: string;
	/** true si le compose ne fournit pas de valeur par défaut. */
	required: boolean;
}

export function composeEnvRefs(composeText: string): ComposeEnvRef[] {
	const refs = new Map<string, boolean>();
	// « $$ » est un dollar littéral dans compose.
	const text = composeText.replace(/\$\$/g, '').replace(/^\s*#.*$/gm, '');
	for (const m of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])[^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
		const key = (m[1] ?? m[3]) as string;
		const op = m[2];
		const required = !op || op.endsWith('?');
		refs.set(key, (refs.get(key) ?? false) || required);
	}
	return [...refs].map(([key, required]) => ({ key, required }));
}

export interface PrefillContext {
	/** Premier domaine du projet (sans schéma). */
	fqdn: string | null;
	appPort: number;
	/** Générateur de secret (navigateur ou serveur). */
	generate: () => string;
}

/** Valeur proposée pour une entrée du modèle, ou null si l'utilisateur doit la saisir. */
export function suggestValue(entry: EnvTemplateEntry, ctx: PrefillContext): { value: string; source: 'default' | 'generated' | 'domain' | 'port' } | null {
	if (entry.kind === 'url' && ctx.fqdn) return { value: `https://${ctx.fqdn}`, source: 'domain' };
	if (entry.kind === 'port') return { value: String(ctx.appPort), source: 'port' };
	if (entry.kind === 'secret' && isPlaceholder(entry.defaultValue)) return { value: ctx.generate(), source: 'generated' };
	if (entry.defaultValue !== '' && !isPlaceholder(entry.defaultValue)) return { value: entry.defaultValue, source: 'default' };
	return null;
}

function formatValue(v: string): string {
	return /[\s#"'$`\\]/.test(v) ? `"${v.replace(/(["\\$`])/g, '\\$1')}"` : v;
}

/**
 * Construit un .env à partir du modèle. Avec `existing`, seules les clés absentes sont
 * ajoutées (à la fin, sous un en-tête) : rien de ce que l'utilisateur a saisi n'est modifié.
 */
export function buildEnvFromTemplate(template: EnvTemplate, ctx: PrefillContext, existing = ''): { text: string; added: string[]; toFill: string[] } {
	const have = new Set(parseEnv(existing).entries.map((e) => e.key));
	const out: string[] = [];
	const added: string[] = [];
	const toFill: string[] = [];
	// Un secret généré remplace aussi sa valeur d'exemple dans les autres variables
	// (ex. DB_PASSWORD=changeme → DATABASE_URL=postgres://app:changeme@db/app).
	const replaced: [string, string][] = [];
	for (const e of template.entries) {
		if (have.has(e.key)) continue;
		let s = suggestValue(e, ctx);
		if (s?.source === 'generated' && e.defaultValue.length >= 4) replaced.push([e.defaultValue, s.value]);
		if (s?.source === 'default') {
			const value = replaced.reduce((v, [from, to]) => v.split(from).join(to), s.value);
			s = { ...s, value };
		}
		if (e.comment) out.push(`# ${e.comment}`);
		out.push(`${e.key}=${s ? formatValue(s.value) : ''}`);
		added.push(e.key);
		if (!s) toFill.push(e.key);
	}
	if (out.length === 0) return { text: existing, added, toFill };
	const base = existing.trimEnd();
	const header = base ? `${base}\n\n# Ajouté depuis ${template.file}\n` : `# Généré par Forge depuis ${template.file}\n`;
	return { text: `${header}${out.join('\n')}\n`, added, toFill };
}

export interface EnvCheck {
	/** Clés du modèle ou requises par le compose, absentes du .env. */
	missing: { key: string; from: 'template' | 'compose' }[];
	/** Clés présentes mais vides ou encore à leur valeur d'exemple. */
	unfilled: string[];
}

export function checkEnvAgainst(envText: string, template: EnvTemplate | null, composeRefs: ComposeEnvRef[] = []): EnvCheck {
	const entries = parseEnv(envText).entries;
	const have = new Map(entries.map((e) => [e.key, e.value]));
	const missing: EnvCheck['missing'] = [];
	for (const e of template?.entries ?? []) if (!have.has(e.key)) missing.push({ key: e.key, from: 'template' });
	for (const r of composeRefs) {
		if (r.required && !have.has(r.key) && !missing.some((m) => m.key === r.key)) missing.push({ key: r.key, from: 'compose' });
	}
	const templateKeys = new Set(template?.entries.map((e) => e.key) ?? []);
	const unfilled = entries.filter((e) => (templateKeys.has(e.key) || composeRefs.some((r) => r.key === e.key)) && isPlaceholder(e.value)).map((e) => e.key);
	return { missing, unfilled };
}

/** Secret aléatoire URL-safe (32 octets → 43 caractères), utilisable côté navigateur et serveur. */
export function randomSecret(bytes = 32): string {
	const buf = new Uint8Array(bytes);
	globalThis.crypto.getRandomValues(buf);
	let bin = '';
	for (const b of buf) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

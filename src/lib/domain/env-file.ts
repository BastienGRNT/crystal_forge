/**
 * Parsing d'un fichier .env collé tel quel.
 * Le texte brut (normalisé) est ce qui part dans le secret ENV_FILE ; le parsing
 * sert à l'aperçu (clés, valeurs masquées) et à la validation.
 */

export interface EnvEntry {
	key: string;
	value: string;
	line: number;
}

export interface EnvIssue {
	line: number;
	level: 'error' | 'warning';
	message: string;
}

export interface ParsedEnv {
	entries: EnvEntry[];
	issues: EnvIssue[];
	normalized: string;
}

/** Limite GitHub pour un secret de dépôt. */
export const GITHUB_SECRET_MAX_BYTES = 48 * 1024;

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function normalizeEnvText(text: string): string {
	let out = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
	if (out.length > 0 && !out.endsWith('\n')) out += '\n';
	return out;
}

export function parseEnv(text: string): ParsedEnv {
	const normalized = normalizeEnvText(text);
	const lines = normalized.split('\n');
	const entries: EnvEntry[] = [];
	const issues: EnvIssue[] = [];
	const seen = new Map<string, number>();

	for (let i = 0; i < lines.length; i++) {
		const lineNo = i + 1;
		const rawLine = lines[i] ?? '';
		const trimmed = rawLine.trim();
		if (trimmed === '' || trimmed.startsWith('#')) continue;

		let body = trimmed.startsWith('export ') ? trimmed.slice(7).trimStart() : trimmed;
		const eq = body.indexOf('=');
		if (eq <= 0) {
			issues.push({ line: lineNo, level: 'error', message: `Ligne ${lineNo} : « = » manquant` });
			continue;
		}
		const key = body.slice(0, eq).trim();
		if (!KEY_RE.test(key)) {
			issues.push({ line: lineNo, level: 'error', message: `Ligne ${lineNo} : nom de variable invalide « ${key} »` });
			continue;
		}
		body = body.slice(eq + 1).trimStart();

		let value: string;
		const quote = body[0];
		if (quote === '"' || quote === "'" || quote === '`') {
			// Valeur entre guillemets, éventuellement sur plusieurs lignes.
			let acc = body.slice(1);
			let closeIdx = findClosingQuote(acc, quote);
			let j = i;
			while (closeIdx < 0 && j + 1 < lines.length) {
				j++;
				acc += '\n' + (lines[j] ?? '');
				closeIdx = findClosingQuote(acc, quote);
			}
			if (closeIdx < 0) {
				issues.push({ line: lineNo, level: 'error', message: `Ligne ${lineNo} : guillemet ${quote} non fermé` });
				i = j;
				continue;
			}
			value = acc.slice(0, closeIdx);
			if (quote === '"') value = unescapeDouble(value);
			i = j;
		} else {
			// Valeur nue : un « # » précédé d'un espace commence un commentaire.
			const hash = body.search(/\s#/);
			value = (hash >= 0 ? body.slice(0, hash) : body).trim();
		}

		if (seen.has(key)) {
			issues.push({
				line: lineNo,
				level: 'warning',
				message: `Ligne ${lineNo} : « ${key} » déjà défini ligne ${seen.get(key)} (la dernière valeur l'emporte)`
			});
			const idx = entries.findIndex((e) => e.key === key);
			if (idx >= 0) entries.splice(idx, 1);
		}
		seen.set(key, lineNo);
		if (value === '') {
			issues.push({ line: lineNo, level: 'warning', message: `Ligne ${lineNo} : « ${key} » est vide` });
		}
		entries.push({ key, value, line: lineNo });
	}

	const bytes = new TextEncoder().encode(normalized).length;
	if (bytes > GITHUB_SECRET_MAX_BYTES) {
		issues.push({
			line: 0,
			level: 'error',
			message: `Le fichier fait ${Math.round(bytes / 1024)} Ko : GitHub limite un secret à 48 Ko`
		});
	}
	return { entries, issues, normalized };
}

function findClosingQuote(s: string, quote: string): number {
	for (let k = 0; k < s.length; k++) {
		if (s[k] === '\\' && quote === '"') {
			k++;
			continue;
		}
		if (s[k] === quote) return k;
	}
	return -1;
}

function unescapeDouble(s: string): string {
	return s.replace(/\\([nrt"\\$])/g, (_, c: string) => {
		switch (c) {
			case 'n':
				return '\n';
			case 'r':
				return '\r';
			case 't':
				return '\t';
			default:
				return c;
		}
	});
}

/** Valeur masquée pour l'affichage : longueur approximative, jamais le contenu. */
export function maskValue(value: string): string {
	if (value.length === 0) return '(vide)';
	return '•'.repeat(Math.min(Math.max(value.length, 6), 24));
}

export function hasEnvErrors(parsed: ParsedEnv): boolean {
	return parsed.issues.some((i) => i.level === 'error');
}

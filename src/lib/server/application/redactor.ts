/**
 * Masque les secrets dans tout texte destiné aux logs ou à l'UI.
 * Deux niveaux : valeurs connues (tokens des réglages, valeurs du .env, jetons
 * d'enregistrement…) et motifs génériques (jetons GitHub, « --token xxx »…).
 */
const MASK = '••••••';

const PATTERNS: RegExp[] = [
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
	/(--token\s+)(\S+)/g,
	/(PVEAPIToken=[^=\s]+=)([0-9a-f-]{36})/gi,
	/(Authorization:\s*Bearer\s+)(\S+)/gi,
	/(X-Ovh-(?:Consumer|Application|Signature):\s*)(\S+)/gi,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];

export class Redactor {
	#values = new Set<string>();
	#sorted: string[] = [];

	add(...values: (string | null | undefined)[]): void {
		let changed = false;
		for (const v of values) {
			if (!v) continue;
			for (const piece of [v, ...v.split('\n')]) {
				const s = piece.trim();
				// Les valeurs trop courtes produiraient des faux positifs partout.
				if (s.length >= 6 && !this.#values.has(s)) {
					this.#values.add(s);
					changed = true;
				}
			}
		}
		if (changed) this.#sorted = [...this.#values].sort((a, b) => b.length - a.length);
	}

	redact(text: string): string {
		let out = text;
		for (const v of this.#sorted) {
			if (out.includes(v)) out = out.split(v).join(MASK);
		}
		for (const re of PATTERNS) {
			out = out.replace(re, (match, prefix?: string) => (typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}${MASK}` : MASK));
		}
		return out;
	}
}

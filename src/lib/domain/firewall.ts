/**
 * Pare-feu Proxmox d'un CT de projet : isole le projet des autres CT du bridge
 * (prod comprise) tout en laissant passer NPM, Forge et l'hôte (Tailscale).
 * Les règles posées par Forge sont reconnaissables à leur commentaire « forge: ».
 */

export const FORGE_RULE_PREFIX = 'forge:';

export interface FirewallRule {
	type: 'in' | 'out';
	action: 'ACCEPT' | 'DROP' | 'REJECT';
	source?: string;
	dest?: string;
	proto?: 'tcp' | 'udp' | 'icmp';
	dport?: string;
	comment: string;
	enable: 1;
}

export interface FirewallOptions {
	enable: 1;
	policy_in: 'DROP';
	policy_out: 'ACCEPT';
	/** Anti-usurpation : le CT ne peut émettre qu'avec son IP configurée. */
	ipfilter: 1;
	macfilter: 1;
}

export interface FirewallPlanInput {
	appPort: number;
	/** IP de Nginx Proxy Manager (10.10.10.2). */
	npmIp: string;
	/** IP de Forge (CT 150) : SSH et sonde du port de l'app. */
	forgeIp: string | null;
	/** Passerelle = hôte Proxmox (Tailscale arrive avec cette IP source après SNAT). */
	gateway: string;
	/** Réseau du bridge (10.10.10.0/24). */
	subnet: string;
}

export const FIREWALL_OPTIONS: FirewallOptions = { enable: 1, policy_in: 'DROP', policy_out: 'ACCEPT', ipfilter: 1, macfilter: 1 };

/**
 * Règles dans l'ordre d'évaluation (la première qui correspond s'applique).
 * Entrées : NPM → port de l'app, Forge → SSH + port, hôte → tout. Le reste est rejeté
 * par policy_in=DROP (connexions déjà établies acceptées par Proxmox).
 * Sorties : vers l'hôte et NPM autorisé, vers le reste du bridge interdit, Internet libre.
 */
export function planFirewallRules(input: FirewallPlanInput): FirewallRule[] {
	const port = String(input.appPort);
	const rules: FirewallRule[] = [
		{ type: 'in', action: 'ACCEPT', source: input.npmIp, proto: 'tcp', dport: port, comment: `${FORGE_RULE_PREFIX} NPM → app`, enable: 1 },
		{ type: 'in', action: 'ACCEPT', source: input.gateway, comment: `${FORGE_RULE_PREFIX} hôte / Tailscale`, enable: 1 }
	];
	if (input.forgeIp) {
		rules.push(
			{ type: 'in', action: 'ACCEPT', source: input.forgeIp, proto: 'tcp', dport: '22', comment: `${FORGE_RULE_PREFIX} Forge → SSH`, enable: 1 },
			{ type: 'in', action: 'ACCEPT', source: input.forgeIp, proto: 'tcp', dport: port, comment: `${FORGE_RULE_PREFIX} Forge → app`, enable: 1 }
		);
	}
	rules.push(
		{ type: 'out', action: 'ACCEPT', dest: input.gateway, comment: `${FORGE_RULE_PREFIX} passerelle / DNS`, enable: 1 },
		{ type: 'out', action: 'DROP', dest: input.subnet, comment: `${FORGE_RULE_PREFIX} isolement du bridge (prod)`, enable: 1 }
	);
	return rules;
}

export interface ExistingRule {
	pos: number;
	type: string;
	action: string;
	source?: string;
	dest?: string;
	proto?: string;
	dport?: string;
	comment?: string;
	enable?: number;
}

const ruleKey = (r: Partial<FirewallRule> | ExistingRule) =>
	[r.type, r.action, r.source ?? '', r.dest ?? '', r.proto ?? '', r.dport ?? '', r.comment ?? '', r.enable ?? 0].join('|');

export function isForgeRule(r: ExistingRule): boolean {
	return (r.comment ?? '').startsWith(FORGE_RULE_PREFIX);
}

/** true si les règles Forge en place sont exactement celles du plan (même ordre). */
export function firewallUpToDate(existing: ExistingRule[], plan: FirewallRule[]): boolean {
	const forge = [...existing].sort((a, b) => a.pos - b.pos).filter(isForgeRule);
	return forge.length === plan.length && forge.every((r, i) => ruleKey(r) === ruleKey(plan[i] as FirewallRule));
}

/** Le réseau /24 (ou autre) qui contient la passerelle : « 10.10.10.1 », 24 → « 10.10.10.0/24 ». */
export function subnetOf(gateway: string, cidr: number): string {
	const parts = gateway.split('.').map(Number);
	const n = (((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)) >>> 0;
	const mask = cidr === 0 ? 0 : (~0 << (32 - cidr)) >>> 0;
	const base = (n & mask) >>> 0;
	return `${[24, 16, 8, 0].map((s) => (base >>> s) & 0xff).join('.')}/${cidr}`;
}

/** Ajoute firewall=1 à une valeur net0 Proxmox (sans toucher au reste). */
export function withFirewallFlag(net0: string): string {
	const parts = net0.split(',').filter((p) => !p.startsWith('firewall='));
	return [...parts, 'firewall=1'].join(',');
}

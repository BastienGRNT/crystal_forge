/**
 * Règles de sécurité de Forge (section 2 du cahier des charges), en fonctions pures.
 * Elles sont appliquées par le garde d'écriture AVANT toute écriture, en plus des
 * permissions Proxmox / NPM / OVH qui restent la vraie barrière.
 */
import { SafetyViolation } from './errors';
import { isInCtidRange, isInIpRange, type CtidRange, type IpRange } from './allocation';
import { isIpv4, parseNetConfig } from './network';

export interface SafetyContext {
	ctidRange: CtidRange;
	ipRange: IpRange;
	pool: string;
	templateId: number;
	bridge: string;
	publicIp: string;
	/** CTID explicitement protégés (prod), en plus du critère « hors pool ». */
	protectedCtids: number[];
	/** IP jamais attribuables (Palworld, NPM…). */
	reservedIps: string[];
}

export type ResourceType =
	| 'pve_ct'
	| 'ovh_record'
	| 'npm_proxy_host'
	| 'npm_certificate'
	| 'gh_runner'
	| 'gh_secret'
	| 'gh_variable'
	| 'gh_workflow';

/** Ressource enregistrée en base comme créée par Forge. */
export interface OwnedResource {
	type: ResourceType;
	externalId: string;
	projectId: number | null;
}

// --- Proxmox --------------------------------------------------------------------

export interface GuestFacts {
	vmid: number;
	pool: string | null;
	template: boolean;
	exists: boolean;
}

/** Une écriture sur un CT existant n'est permise que si Forge l'a créé, qu'il est dans le pool et dans la plage. */
export function assertCanModifyCt(ctx: SafetyContext, guest: GuestFacts, owned: OwnedResource[]): void {
	if (ctx.protectedCtids.includes(guest.vmid)) {
		throw new SafetyViolation('ct.protected', `Le CT ${guest.vmid} est un CT de production protégé : aucune action possible.`);
	}
	if (guest.vmid === ctx.templateId) {
		throw new SafetyViolation('ct.template', `Le CT ${guest.vmid} est le template de Forge : il ne peut pas être modifié.`);
	}
	if (!guest.exists) {
		throw new SafetyViolation('ct.missing', `Le CT ${guest.vmid} n'existe pas.`);
	}
	if (guest.template) {
		throw new SafetyViolation('ct.is-template', `Le CT ${guest.vmid} est un template.`);
	}
	if (!isInCtidRange(guest.vmid, ctx.ctidRange)) {
		throw new SafetyViolation(
			'ct.out-of-range',
			`Le CT ${guest.vmid} est hors de la plage Forge (${ctx.ctidRange.min}-${ctx.ctidRange.max}).`
		);
	}
	if (guest.pool !== ctx.pool) {
		throw new SafetyViolation('ct.out-of-pool', `Le CT ${guest.vmid} n'est pas dans le pool « ${ctx.pool} » : lecture seule.`);
	}
	if (!owned.some((r) => r.type === 'pve_ct' && r.externalId === String(guest.vmid))) {
		throw new SafetyViolation('ct.not-owned', `Le CT ${guest.vmid} n'a pas été créé par Forge : lecture seule.`);
	}
}

export interface CloneRequest {
	sourceId: number;
	newId: number;
	pool: string;
	existingIds: number[];
}

export function assertCanCloneCt(ctx: SafetyContext, req: CloneRequest): void {
	if (req.sourceId !== ctx.templateId) {
		throw new SafetyViolation('clone.source', `Seul le template ${ctx.templateId} peut être cloné (demandé : ${req.sourceId}).`);
	}
	if (!isInCtidRange(req.newId, ctx.ctidRange)) {
		throw new SafetyViolation('clone.range', `CTID ${req.newId} hors de la plage ${ctx.ctidRange.min}-${ctx.ctidRange.max}.`);
	}
	if (ctx.protectedCtids.includes(req.newId) || req.existingIds.includes(req.newId)) {
		throw new SafetyViolation('clone.exists', `Le CTID ${req.newId} est déjà utilisé.`);
	}
	if (req.pool !== ctx.pool) {
		throw new SafetyViolation('clone.pool', `Le clone doit aller dans le pool « ${ctx.pool} ».`);
	}
}

/** Contrôle des clés de config qu'un PUT /config peut modifier. */
const ALLOWED_CONFIG_KEYS = new Set([
	'hostname',
	'cores',
	'memory',
	'swap',
	'net0',
	'onboot',
	'tags',
	'description',
	'nameserver',
	'searchdomain'
]);

export function assertSafeCtConfig(ctx: SafetyContext, config: Record<string, unknown>, usedIps: string[]): void {
	for (const key of Object.keys(config)) {
		if (!ALLOWED_CONFIG_KEYS.has(key)) {
			throw new SafetyViolation('config.key', `Clé de configuration interdite : ${key}`);
		}
	}
	if (typeof config.net0 === 'string') {
		const net = parseNetConfig(config.net0);
		if (net.bridge !== ctx.bridge) {
			throw new SafetyViolation('config.bridge', `Le CT doit être sur le bridge « ${ctx.bridge} » (demandé : ${net.bridge}).`);
		}
		if (!net.ip || !isInIpRange(net.ip, ctx.ipRange)) {
			throw new SafetyViolation('config.ip-range', `IP ${net.ip ?? '?'} hors de la plage Forge ${ctx.ipRange.start}-${ctx.ipRange.end}.`);
		}
		if (ctx.reservedIps.includes(net.ip)) {
			throw new SafetyViolation('config.ip-reserved', `L'IP ${net.ip} est réservée.`);
		}
		if (usedIps.includes(net.ip)) {
			throw new SafetyViolation('config.ip-used', `L'IP ${net.ip} est déjà utilisée par un autre CT.`);
		}
	}
}

// --- DNS (OVH) ------------------------------------------------------------------

export interface DnsRecordFacts {
	id: number;
	fieldType: string;
	subDomain: string;
	target: string;
}

export function assertCanCreateDnsRecord(
	ctx: SafetyContext,
	req: { zone: string; subDomain: string; fieldType: string; target: string },
	existing: DnsRecordFacts[]
): void {
	if (req.fieldType !== 'A') {
		throw new SafetyViolation('dns.type', `Seuls les enregistrements A sont autorisés (jamais d'AAAA). Demandé : ${req.fieldType}.`);
	}
	if (req.target !== ctx.publicIp) {
		throw new SafetyViolation('dns.target', `La cible doit être l'IP publique ${ctx.publicIp} (demandé : ${req.target}).`);
	}
	const sameName = existing.filter((r) => r.subDomain.toLowerCase() === req.subDomain.toLowerCase());
	const conflicting = sameName.filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.fieldType));
	if (conflicting.length > 0) {
		const desc = conflicting.map((r) => `${r.fieldType} → ${r.target}`).join(', ');
		const name = req.subDomain ? `${req.subDomain}.${req.zone}` : req.zone;
		throw new SafetyViolation('dns.exists', `Un enregistrement existe déjà pour ${name} (${desc}) : rien n'est écrasé.`);
	}
}

/** Un wildcard couvrant le nom n'empêche pas la création, mais doit être signalé. */
export function wildcardCovering(subDomain: string, existing: DnsRecordFacts[]): DnsRecordFacts | undefined {
	const parent = subDomain.includes('.') ? subDomain.slice(subDomain.indexOf('.') + 1) : '';
	const wildcard = parent ? `*.${parent}` : '*';
	return existing.find((r) => r.subDomain === wildcard && ['A', 'AAAA', 'CNAME'].includes(r.fieldType));
}

// --- Ressources « possédées » (NPM, OVH, GitHub) ----------------------------------

export function assertOwned(type: ResourceType, externalId: string | number, owned: OwnedResource[], label: string): void {
	const id = String(externalId);
	if (!owned.some((r) => r.type === type && r.externalId === id)) {
		throw new SafetyViolation(
			'resource.not-owned',
			`${label} ${id} n'a pas été créé par Forge : modification et suppression interdites.`
		);
	}
}

// --- NPM ------------------------------------------------------------------------

export function assertCanCreateProxyHost(
	ctx: SafetyContext,
	req: { domainNames: string[]; forwardHost: string; forwardPort: number },
	existingDomainNames: string[]
): void {
	if (!isIpv4(req.forwardHost) || !isInIpRange(req.forwardHost, ctx.ipRange)) {
		throw new SafetyViolation('npm.forward', `La cible ${req.forwardHost} n'est pas un CT Forge (${ctx.ipRange.start}-${ctx.ipRange.end}).`);
	}
	if (!Number.isInteger(req.forwardPort) || req.forwardPort < 1 || req.forwardPort > 65535) {
		throw new SafetyViolation('npm.port', `Port invalide : ${req.forwardPort}`);
	}
	const taken = new Set(existingDomainNames.map((d) => d.toLowerCase()));
	const dup = req.domainNames.filter((d) => taken.has(d.toLowerCase()));
	if (dup.length > 0) {
		throw new SafetyViolation('npm.exists', `Un proxy host existe déjà pour ${dup.join(', ')} : rien n'est écrasé.`);
	}
}

// --- Commandes (SSH, workflow) ----------------------------------------------------

const FORBIDDEN_COMMAND_PATTERNS: { re: RegExp; reason: string }[] = [
	{ re: /\bdown\b[^;&|\n]*\s(-v|--volumes)\b/, reason: '« docker compose down -v » supprime les volumes' },
	{ re: /\bdocker\s+volume\s+(rm|prune)\b/, reason: 'suppression de volume Docker' },
	{ re: /\bsystem\s+prune\b[^;&|\n]*--volumes\b/, reason: '« docker system prune --volumes » supprime les volumes' },
	{ re: /\bdocker\s+(container\s+)?rm\b[^;&|\n]*\s(-v|--volumes|-[a-z]*v[a-z]*)\b/, reason: '« docker rm -v » supprime les volumes anonymes' },
	{ re: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+\/(\s|$)/, reason: 'rm -rf /' },
	{ re: /\b(mkfs|dd\s+if=)/, reason: 'commande destructrice' }
];

export function assertSafeCommand(command: string): void {
	for (const { re, reason } of FORBIDDEN_COMMAND_PATTERNS) {
		if (re.test(command)) {
			throw new SafetyViolation('command.forbidden', `Commande refusée (${reason}) : ${command}`);
		}
	}
}

export function assertSshTarget(ctx: SafetyContext, host: string, knownForgeIps: string[]): void {
	if (!isIpv4(host) || !isInIpRange(host, ctx.ipRange)) {
		throw new SafetyViolation('ssh.range', `SSH refusé vers ${host} : hors de la plage Forge.`);
	}
	if (!knownForgeIps.includes(host)) {
		throw new SafetyViolation('ssh.unknown', `SSH refusé vers ${host} : aucun projet Forge n'utilise cette IP.`);
	}
}

// --- GitHub ---------------------------------------------------------------------

export function assertGithubRepoAllowed(owner: string, repo: string, allowedOwner: string, projectRepos: string[]): void {
	if (owner.toLowerCase() !== allowedOwner.toLowerCase()) {
		throw new SafetyViolation('github.owner', `Le dépôt ${owner}/${repo} n'appartient pas à ${allowedOwner}.`);
	}
	if (!projectRepos.map((r) => r.toLowerCase()).includes(`${owner}/${repo}`.toLowerCase())) {
		throw new SafetyViolation('github.repo', `Le dépôt ${owner}/${repo} n'est lié à aucun projet Forge.`);
	}
}

export function assertForgeVariableName(name: string): void {
	if (!/^FORGE_[A-Z0-9_]+$/.test(name)) {
		throw new SafetyViolation('github.variable', `Variable interdite : ${name} (seules les variables FORGE_* sont gérées).`);
	}
}

export const FORGE_SECRET_NAME = 'ENV_FILE';

export function assertForgeSecretName(name: string): void {
	if (name !== FORGE_SECRET_NAME) {
		throw new SafetyViolation('github.secret', `Secret interdit : ${name} (seul ${FORGE_SECRET_NAME} est géré).`);
	}
}

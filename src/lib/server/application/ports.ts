/**
 * Ports : interfaces des systèmes externes. Implémentées par les clients réels
 * (infrastructure/clients) et par les simulateurs du mode mock (infrastructure/mock).
 * Les cas d'usage n'utilisent jamais ces ports directement pour écrire : ils passent
 * par les passerelles (gateways) qui appliquent le garde d'écriture.
 */

// --- Proxmox ----------------------------------------------------------------------

export interface PveGuest {
	vmid: number;
	name: string;
	type: 'lxc' | 'qemu';
	status: string;
	node: string;
	pool: string | null;
	template: boolean;
	tags: string[];
	cpu: number;
	maxcpu: number;
	mem: number;
	maxmem: number;
	disk: number;
	maxdisk: number;
	uptime: number;
}

export interface PveNodeStatus {
	cpu: number;
	cpus: number;
	memory: { total: number; used: number; free: number };
	swap: { total: number; used: number };
	rootfs: { total: number; used: number };
	uptime: number;
	loadavg: string[];
	pveversion: string;
}

export interface PveStorageStatus {
	total: number;
	used: number;
	avail: number;
	content: string;
}

export interface PveTaskStatus {
	status: 'running' | 'stopped';
	exitstatus?: string;
}

export type PvePermissions = Record<string, Record<string, number>>;

export interface PveCloneParams {
	newid: number;
	hostname: string;
	pool: string;
	storage: string;
	full: boolean;
	description?: string;
}

export type PowerAction = 'start' | 'stop' | 'shutdown' | 'reboot';

export interface PveFirewallRule {
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

export interface PveNetworkIface {
	iface: string;
	type: string;
	active?: number;
	cidr?: string;
	address?: string;
}

export interface PveBackupJob {
	id: string;
	enabled: boolean;
	schedule: string;
	vmid: string | null;
	all: boolean;
	storage: string | null;
}

export interface ProxmoxApi {
	version(): Promise<{ version: string; release: string }>;
	nodeStatus(): Promise<PveNodeStatus>;
	storageStatus(storage: string): Promise<PveStorageStatus>;
	guests(): Promise<PveGuest[]>;
	guestConfig(vmid: number, type: 'lxc' | 'qemu'): Promise<Record<string, unknown>>;
	permissions(path?: string): Promise<PvePermissions>;
	/** VMID membres d'un pool (GET /pools/{pool}, exige Pool.Audit). */
	poolMembers(pool: string): Promise<number[]>;
	isIdFree(vmid: number): Promise<boolean>;
	taskStatus(upid: string): Promise<PveTaskStatus>;
	taskLog(upid: string, start: number): Promise<{ n: number; t: string }[]>;
	listBackups(storage: string, vmid: number): Promise<{ volid: string; ctime: number; size: number }[]>;
	ctFirewallOptions(vmid: number): Promise<Record<string, unknown>>;
	ctFirewallRules(vmid: number): Promise<PveFirewallRule[]>;
	clusterFirewallOptions(): Promise<Record<string, unknown>>;
	nodeNetworks(): Promise<PveNetworkIface[]>;
	backupJobs(): Promise<PveBackupJob[]>;

	clone(sourceId: number, params: PveCloneParams): Promise<string>;
	updateConfig(vmid: number, config: Record<string, string | number>): Promise<void>;
	resize(vmid: number, disk: string, size: string): Promise<string | null>;
	power(vmid: number, action: PowerAction): Promise<string>;
	destroy(vmid: number): Promise<string>;
	vzdump(vmid: number, storage: string): Promise<string>;
	setCtFirewallOptions(vmid: number, options: Record<string, string | number>): Promise<void>;
	addCtFirewallRule(vmid: number, rule: Record<string, string | number>): Promise<void>;
	deleteCtFirewallRule(vmid: number, pos: number): Promise<void>;
}

// --- GitHub -----------------------------------------------------------------------

export interface GhRepo {
	owner: string;
	name: string;
	fullName: string;
	private: boolean;
	defaultBranch: string;
	description: string | null;
	pushedAt: string | null;
	htmlUrl: string;
	archived: boolean;
}

export interface GhDirEntry {
	name: string;
	path: string;
	type: 'file' | 'dir' | 'symlink' | 'submodule';
}

export interface GhRunner {
	id: number;
	name: string;
	status: 'online' | 'offline';
	busy: boolean;
	labels: string[];
}

export interface GhRun {
	id: number;
	runNumber: number;
	name: string;
	status: string;
	conclusion: string | null;
	event: string;
	headSha: string;
	headBranch: string | null;
	commitMessage: string | null;
	actor: string | null;
	createdAt: string;
	updatedAt: string;
	htmlUrl: string;
}

export interface GhRunJob {
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
	startedAt: string | null;
	completedAt: string | null;
	steps: { number: number; name: string; status: string; conclusion: string | null }[];
}

export interface GithubApi {
	whoami(): Promise<{ login: string; tokenExpiresAt: string | null }>;
	listRepos(): Promise<GhRepo[]>;
	getRepo(owner: string, repo: string): Promise<GhRepo>;
	listDir(owner: string, repo: string, path: string, ref?: string): Promise<GhDirEntry[]>;
	getFile(owner: string, repo: string, path: string, ref?: string): Promise<{ content: string; sha: string } | null>;
	listRunners(owner: string, repo: string): Promise<GhRunner[]>;
	listWorkflowRuns(owner: string, repo: string, workflowFile: string, perPage?: number): Promise<GhRun[]>;
	/** Derniers runs du dépôt, tous workflows confondus. */
	listRepoRuns(owner: string, repo: string, perPage?: number): Promise<GhRun[]>;
	getRun(owner: string, repo: string, runId: number): Promise<GhRun>;
	getRunJobs(owner: string, repo: string, runId: number): Promise<GhRunJob[]>;
	getJobLogs(owner: string, repo: string, jobId: number): Promise<string>;
	getPublicKey(owner: string, repo: string): Promise<{ keyId: string; key: string }>;
	getSecretMeta(owner: string, repo: string, name: string): Promise<{ updatedAt: string } | null>;
	listVariables(owner: string, repo: string): Promise<{ name: string; value: string }[]>;
	/** Dernier commit d'une branche. */
	latestCommit(owner: string, repo: string, branch: string): Promise<{ sha: string; message: string; date: string | null }>;
	/** Archive tar.gz du dépôt à un commit donné (dossier racine « owner-repo-sha/ »). */
	downloadTarball(owner: string, repo: string, ref: string): Promise<Buffer>;

	createRegistrationToken(owner: string, repo: string): Promise<{ token: string; expiresAt: string }>;
	createRemoveToken(owner: string, repo: string): Promise<{ token: string; expiresAt: string }>;
	deleteRunner(owner: string, repo: string, runnerId: number): Promise<void>;
	putSecret(owner: string, repo: string, name: string, encryptedValue: string, keyId: string): Promise<void>;
	deleteSecret(owner: string, repo: string, name: string): Promise<void>;
	setVariable(owner: string, repo: string, name: string, value: string): Promise<'created' | 'updated'>;
	deleteVariable(owner: string, repo: string, name: string): Promise<void>;
	createFile(
		owner: string,
		repo: string,
		path: string,
		content: string,
		message: string,
		branch: string
	): Promise<{ commitSha: string; contentSha: string }>;
	/** Met à jour un fichier existant (sha = version actuelle, refus si elle a changé entre-temps). */
	updateFile(owner: string, repo: string, path: string, content: string, message: string, branch: string, sha: string): Promise<{ commitSha: string; contentSha: string }>;
	deleteFile(owner: string, repo: string, path: string, sha: string, message: string, branch: string): Promise<void>;
	dispatchWorkflow(owner: string, repo: string, workflowFile: string, ref: string): Promise<{ runId: number | null; htmlUrl: string | null }>;
}

// --- OVH --------------------------------------------------------------------------

export interface OvhRecord {
	id: number;
	zone: string;
	fieldType: string;
	subDomain: string;
	target: string;
	ttl: number;
}

export interface OvhCredential {
	status: string;
	applicationId: number | null;
	expiration: string | null;
	rules: { method: string; path: string }[];
}

export interface OvhApi {
	currentCredential(): Promise<OvhCredential>;
	listZones(): Promise<string[]>;
	listRecordIds(zone: string, filter?: { subDomain?: string; fieldType?: string }): Promise<number[]>;
	getRecord(zone: string, id: number): Promise<OvhRecord>;

	createRecord(zone: string, record: { fieldType: string; subDomain: string; target: string; ttl: number }): Promise<OvhRecord>;
	refreshZone(zone: string): Promise<void>;
	deleteRecord(zone: string, id: number): Promise<void>;
}

// --- Nginx Proxy Manager ------------------------------------------------------------

export interface NpmProxyHost {
	id: number;
	domainNames: string[];
	forwardScheme: string;
	forwardHost: string;
	forwardPort: number;
	certificateId: number;
	sslForced: boolean;
	enabled: boolean;
	nginxOnline: boolean | null;
	nginxError: string | null;
	certificate: { id: number; expiresOn: string | null; provider: string } | null;
}

export interface NpmCertificate {
	id: number;
	niceName: string;
	domainNames: string[];
	expiresOn: string | null;
	provider: string;
}

export interface NpmUser {
	id: number;
	email: string;
	name: string;
	roles: string[];
	permissions: Record<string, string> | null;
}

export interface NpmCreateProxyHost {
	domain_names: string[];
	forward_scheme: 'http' | 'https';
	forward_host: string;
	forward_port: number;
	certificate_id: 'new' | number;
	ssl_forced: boolean;
	http2_support: boolean;
	block_exploits: boolean;
	allow_websocket_upgrade: boolean;
	hsts_enabled: boolean;
	caching_enabled: boolean;
	access_list_id: number;
	advanced_config: string;
	enabled: boolean;
	locations: unknown[];
	meta: { letsencrypt_agree: boolean; letsencrypt_email: string; dns_challenge: boolean };
}

export interface NpmApi {
	health(): Promise<{ status: string; version: string }>;
	me(): Promise<NpmUser>;
	listProxyHosts(): Promise<NpmProxyHost[]>;
	listCertificates(): Promise<NpmCertificate[]>;

	createProxyHost(payload: NpmCreateProxyHost): Promise<NpmProxyHost>;
	deleteProxyHost(id: number): Promise<void>;
	deleteCertificate(id: number): Promise<void>;
}

// --- SSH, sondes, DNS public ---------------------------------------------------------

export interface SshTarget {
	host: string;
	user: 'root' | 'github';
	privateKey: string;
	/** Empreinte attendue (TOFU) ; null = première connexion, l'empreinte est renvoyée. */
	expectedHostKey: string | null;
}

export interface SshResult {
	code: number;
	stdout: string;
	stderr: string;
	hostKey: string;
}

export interface SshApi {
	exec(target: SshTarget, command: string, opts?: { timeoutMs?: number; onOutput?: (chunk: string) => void; stdin?: Buffer }): Promise<SshResult>;
}

export interface ProbeApi {
	ping(ip: string): Promise<boolean>;
	/** null si l'ARP n'est pas observable depuis cette machine (pas sur le même L2). */
	arpHas(ip: string): Promise<boolean | null>;
	tcpOpen(host: string, port: number, timeoutMs?: number): Promise<boolean>;
	/**
	 * GET sans suivre les redirections. `connectTo` : IP à joindre à la place de celle du DNS
	 * (le nom reste utilisé pour SNI, le certificat et l'en-tête Host).
	 */
	http(url: string, timeoutMs?: number, opts?: { connectTo?: string }): Promise<{ ok: boolean; status: number | null; error: string | null; ms: number }>;
}

export interface ResolverApi {
	resolveA(name: string): Promise<string[]>;
}

export interface ExternalApis {
	proxmox: ProxmoxApi;
	github: GithubApi;
	ovh: OvhApi;
	npm: NpmApi;
	ssh: SshApi;
	probe: ProbeApi;
	resolver: ResolverApi;
}

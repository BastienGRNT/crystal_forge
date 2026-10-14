import type { AppConfig } from '$server/infrastructure/config';
import type { DomainRepo, JobRepo, ProjectRepo, ResourceRepo } from '$server/infrastructure/db/repositories';
import type { EventBus } from './events';
import type { DnsGateway, GithubGateway, ProxmoxGateway, ProxyGateway, ShellGateway } from './gateways';
import type { WriteGuard } from './guard';
import type { ProbeApi, ResolverApi } from './ports';
import type { Redactor } from './redactor';
import type { Cipher, SettingsService } from './settings';

/** Tout ce dont les cas d'usage et les étapes de job ont besoin (injecté par le conteneur). */
export interface ForgeServices {
	config: AppConfig;
	settings: SettingsService;
	redactor: Redactor;
	guard: WriteGuard;
	cipher: Cipher;
	events: EventBus;
	proxmox: ProxmoxGateway;
	github: GithubGateway;
	dns: DnsGateway;
	proxy: ProxyGateway;
	shell: ShellGateway;
	probe: () => ProbeApi;
	resolver: () => ResolverApi;
	repos: {
		projects: ProjectRepo;
		domains: DomainRepo;
		jobs: JobRepo;
		resources: ResourceRepo;
	};
}

export const envAad = (projectId: number) => `project:${projectId}:env`;

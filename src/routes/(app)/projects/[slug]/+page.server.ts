import { forge } from '$server/container';
import type { PageServerLoad } from './$types';

/** Aperçu d'un projet : l'essentiel sur une page (en ligne ?, ressources, services, derniers jobs). */
export const load: PageServerLoad = async ({ params, depends }) => {
	depends('forge:overview');
	const f = forge();
	const p = f.projects.get(params.slug);
	const view = await f.projects.containerView(p).catch(() => ({ guest: null, config: null, backups: [] as unknown[] }));
	const g = view.guest;
	return {
		guest: g ? { status: g.status, cpu: g.cpu, maxcpu: g.maxcpu, mem: g.mem, maxmem: g.maxmem, disk: g.disk, maxdisk: g.maxdisk, uptime: g.uptime } : null,
		lastBackup: (view.backups as { ctime?: number }[]).reduce<number | null>((m, b) => (b.ctime && (!m || b.ctime > m) ? b.ctime : m), null),
		services: f.projects.containerServices(p, g?.status === 'running'),
		jobs: f.jobs.list({ projectId: p.id, limit: 5 }),
		build: { buildMode: p.buildMode, autoDeploy: p.autoDeploy, deployedSha: p.deployedSha, deployMode: p.deployMode, appService: p.appService, appPort: p.appPort, dbKind: p.dbKind }
	};
};

/**
 * « Mettre à niveau le projet » : compare ce que Forge produirait aujourd'hui avec ce qui
 * est en place (workflow, variables, pare-feu, taille, mises à jour de sécurité) et
 * applique les éléments choisis via un job (avec confirmation pour le workflow).
 */
import { errorMessage, UserFacingError } from '$lib/domain/errors';
import { buildRepoVariables, generateWorkflow, WORKFLOW_PATH, workflowVersion, WORKFLOW_VERSION } from '$lib/domain/workflow';
import { lineDiff, type DiffLine } from '$lib/domain/diff';
import type { ProjectRow } from '$server/infrastructure/db/schema';
import { ReadCommand } from '../gateways';
import type { JobEngine } from '../jobs/engine';
import { firewallPlan } from '../jobs/steps/firewall';
import { sizeOf } from '../jobs/steps/common';
import type { ForgeServices } from '../services';

export type UpgradeKey = 'workflow' | 'variables' | 'firewall' | 'size' | 'os_updates';
export const UPGRADE_KEYS: UpgradeKey[] = ['workflow', 'variables', 'firewall', 'size', 'os_updates'];

export interface UpgradeItem {
	key: UpgradeKey;
	label: string;
	/** ok : à jour · outdated : applicable · blocked : action manuelle · unknown : lecture impossible */
	status: 'ok' | 'outdated' | 'blocked' | 'unknown';
	detail: string;
	diff?: DiffLine[];
	/** Nouveau contenu à reporter à la main (workflow modifié hors Forge). */
	expected?: string;
}

export class UpgradeService {
	constructor(
		private readonly s: ForgeServices,
		private readonly engine: JobEngine
	) {}

	async view(p: ProjectRow): Promise<UpgradeItem[]> {
		const safe = async (key: UpgradeKey, label: string, fn: () => Promise<Omit<UpgradeItem, 'key' | 'label'>>): Promise<UpgradeItem> => {
			try {
				return { key, label, ...(await fn()) };
			} catch (err) {
				return { key, label, status: 'unknown', detail: errorMessage(err) };
			}
		};
		const { github, proxmox, repos } = this.s;

		return Promise.all([
			safe('workflow', 'Workflow de déploiement', async () => {
				const current = await github.api.getFile(p.repoOwner, p.repoName, WORKFLOW_PATH, p.branch);
				const expected = generateWorkflow({ slug: p.slug, branch: p.branch, mode: p.deployMode, ctid: p.ctid });
				if (!current) return { status: 'blocked', detail: `${WORKFLOW_PATH} est absent de ${p.branch}.` };
				const v = workflowVersion(current.content);
				if (current.content === expected) return { status: 'ok', detail: `Version ${v ?? '?'} (la plus récente).` };
				const diff = lineDiff(current.content, expected);
				const owned = repos.resources.findActive('gh_workflow', `${p.repoOwner}/${p.repoName}:${WORKFLOW_PATH}`);
				const sha = owned ? (JSON.parse(owned.meta || '{}') as { sha?: string }).sha : undefined;
				if (!owned || sha !== current.sha) {
					return {
						status: 'blocked',
						detail: `Modifié en dehors de Forge : il n'est pas écrasé. Reportez les changements vous-même (v${v ?? '?'} → v${WORKFLOW_VERSION}).`,
						diff,
						expected
					};
				}
				return { status: 'outdated', detail: `Version ${v ?? '?'} → ${WORKFLOW_VERSION}. Commit « [skip ci] » après confirmation : pas de déploiement déclenché.`, diff };
			}),
			safe('variables', 'Variables FORGE_* du dépôt', async () => {
				const expected = buildRepoVariables({ mode: p.deployMode, composeFile: p.composeFile, workdir: p.workdir, postDeploy: p.postDeploy, appService: p.appService, appPort: p.appPort, dbService: p.dbService, dbKind: p.dbKind });
				const current = new Map((await github.api.listVariables(p.repoOwner, p.repoName)).map((v) => [v.name, v.value]));
				const diffs = Object.entries(expected).filter(([k, v]) => (current.get(k) ?? '') !== v).map(([k, v]) => `${k} : ${current.get(k) ?? '∅'} → ${v || '∅'}`);
				return diffs.length ? { status: 'outdated', detail: diffs.join(' · ') } : { status: 'ok', detail: 'Identiques à la configuration du projet.' };
			}),
			safe('firewall', 'Pare-feu du CT', async () => {
				if (!p.ctid) return { status: 'unknown', detail: 'Pas encore de CT.' };
				const st = await proxmox.firewallStatus(p.ctid, firewallPlan(this.s, p));
				return st.upToDate ? { status: 'ok', detail: 'Règles Forge à jour.' } : { status: 'outdated', detail: st.enabled ? 'Règles différentes du modèle actuel.' : 'Aucun pare-feu sur ce CT.' };
			}),
			safe('size', 'Taille du CT', async () => {
				if (!p.ctid) return { status: 'unknown', detail: 'Pas encore de CT.' };
				const cfg = await proxmox.guestConfig(p.ctid);
				const size = sizeOf(p);
				const disk = Number(/size=(\d+)G/.exec(String(cfg.rootfs ?? ''))?.[1] ?? 0);
				const diffs = [
					Number(cfg.cores) !== size.cores && `cœurs ${cfg.cores} → ${size.cores}`,
					Number(cfg.memory) !== size.memoryMb && `RAM ${cfg.memory} → ${size.memoryMb} Mo`,
					disk < size.diskGb && `disque ${disk} → ${size.diskGb} Go`
				].filter(Boolean);
				return diffs.length
					? { status: 'outdated', detail: `Différente de la taille enregistrée (modifiée dans Proxmox ?) : ${diffs.join(', ')}.` }
					: { status: 'ok', detail: `${size.cores} cœur(s), ${size.memoryMb} Mo, ${disk} Go.` };
			}),
			safe('os_updates', 'Mises à jour de sécurité', async () => {
				if (!p.ip) return { status: 'unknown', detail: 'Pas encore de CT.' };
				const res = await this.s.shell.read({ ip: p.ip, sshHostKey: p.sshHostKey }, ReadCommand.versions());
				const kv = Object.fromEntries(res.stdout.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
				const info = `${kv.os ?? 'OS ?'} · Docker ${kv.docker || '?'}`;
				return kv.unattended === 'enabled'
					? { status: 'ok', detail: `Automatiques (unattended-upgrades). ${info}.` }
					: { status: 'outdated', detail: `Non automatiques. ${info}. Active unattended-upgrades (dépôts de sécurité Ubuntu seulement, Docker exclu).` };
			})
		]);
	}

	async apply(p: ProjectRow, keys: string[]): Promise<number> {
		if (this.s.repos.jobs.activeForProject(p.id)) throw new UserFacingError('Un job est déjà en cours pour ce projet.');
		const items = UPGRADE_KEYS.filter((k) => keys.includes(k));
		if (items.length === 0) throw new UserFacingError('Choisissez au moins un élément à mettre à niveau.');
		return this.engine.enqueue({ type: 'upgrade', projectId: p.id, params: { items, onlyVars: true, forceFirewall: true } }).id;
	}
}

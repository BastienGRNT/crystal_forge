import type { JobDefinition, StepDefinition } from './types';
import { containerStep } from './steps/container';
import { runnerStep } from './steps/runner';
import { secretsStep } from './steps/secrets';
import { workflowStep } from './steps/workflow';
import { dnsStep } from './steps/dns';
import { proxyRepointStep, proxyStep } from './steps/proxy';
import { pipelineStep } from './steps/pipeline';
import { firewallStep } from './steps/firewall';
import { dbBackupStep, dbRestoreStep } from './steps/database';
import { osUpdatesStep, resizeStep, upgradeWorkflowStep } from './steps/upgrade';
import {
	backupStep,
	destroyCtStep,
	finalizeStep,
	powerStep,
	removeDomainStep,
	rollbackStep,
	teardownDnsStep,
	teardownGithubStep,
	teardownProxyStep
} from './steps/maintenance';

export const STEPS: Record<string, StepDefinition> = Object.fromEntries(
	[
		containerStep,
		firewallStep,
		dbBackupStep,
		dbRestoreStep,
		resizeStep,
		upgradeWorkflowStep,
		osUpdatesStep,
		runnerStep,
		secretsStep,
		workflowStep,
		dnsStep,
		proxyStep,
		proxyRepointStep,
		pipelineStep,
		powerStep,
		removeDomainStep,
		backupStep,
		teardownGithubStep,
		teardownProxyStep,
		teardownDnsStep,
		destroyCtStep,
		finalizeStep,
		rollbackStep
	].map((s) => [s.key, s])
);

const setStatus = (status: 'deploying' | 'active' | 'error') => (ctx: Parameters<NonNullable<JobDefinition['onStart']>>[0]) => {
	if (!ctx.dryRun) ctx.updateProject({ status });
};

export const JOB_DEFINITIONS: Record<string, JobDefinition> = {
	deploy: {
		type: 'deploy',
		label: 'Déploiement initial',
		steps: () => ['ct', 'firewall', 'runner', 'secrets', 'workflow', 'dns', 'npm', 'pipeline'],
		onStart: setStatus('deploying'),
		onSuccess: setStatus('active'),
		onFailure: setStatus('error')
	},
	redeploy: {
		type: 'redeploy',
		label: 'Redéploiement',
		steps: () => ['pipeline']
	},
	update_env: {
		type: 'update_env',
		label: 'Mise à jour du .env',
		steps: (p) => (p.redeploy ? ['secrets', 'pipeline'] : ['secrets'])
	},
	sync_config: {
		type: 'sync_config',
		label: 'Mise à jour de la configuration',
		steps: (p) => (p.redeploy ? ['secrets', 'pipeline'] : ['secrets'])
	},
	change_port: {
		type: 'change_port',
		label: 'Changement de port',
		// Pare-feu d'abord : NPM doit pouvoir joindre le nouveau port avant d'y être redirigé.
		steps: (p) => ['firewall', 'npm_repoint', 'secrets', ...(p.redeploy ? ['pipeline'] : [])]
	},
	add_domain: {
		type: 'add_domain',
		label: 'Ajout de domaine',
		steps: () => ['dns', 'npm']
	},
	repair_domain: {
		type: 'repair_domain',
		label: 'Réparation du proxy',
		steps: () => ['npm']
	},
	remove_domain: {
		type: 'remove_domain',
		label: 'Retrait de domaine',
		steps: () => ['remove_domain']
	},
	power: {
		type: 'power',
		label: 'Alimentation du CT',
		steps: () => ['power']
	},
	delete_project: {
		type: 'delete_project',
		label: 'Suppression du projet',
		steps: (p) =>
			p.mode === 'forget' ? ['finalize'] : ['backup', 'teardown_github', 'teardown_proxy', 'teardown_dns', 'destroy_ct', 'finalize']
	},
	firewall: {
		type: 'firewall',
		label: 'Pare-feu du CT',
		steps: () => ['firewall']
	},
	db_backup: {
		type: 'db_backup',
		label: 'Sauvegarde de la base',
		steps: () => ['db_backup']
	},
	db_restore: {
		type: 'db_restore',
		label: 'Restauration de la base',
		steps: () => ['db_backup', 'db_restore']
	},
	resize: {
		type: 'resize',
		label: 'Changement de taille',
		steps: () => ['resize']
	},
	upgrade: {
		type: 'upgrade',
		label: 'Mise à niveau du projet',
		// Ordre fixe ; seuls les éléments choisis par l'utilisateur sont exécutés.
		steps: (p) => {
			const items = new Set((p.items as string[] | undefined) ?? []);
			const map: [string, string][] = [
				['workflow', 'upgrade_workflow'],
				['variables', 'secrets'],
				['firewall', 'firewall'],
				['size', 'resize'],
				['os_updates', 'os_updates']
			];
			return map.filter(([k]) => items.has(k)).map(([, step]) => step);
		}
	},
	rollback: {
		type: 'rollback',
		label: 'Annulation (rollback)',
		steps: () => ['rollback']
	}
};

export function jobLabel(type: string): string {
	return JOB_DEFINITIONS[type]?.label ?? type;
}

export function stepLabel(key: string): string {
	return STEPS[key]?.label ?? key;
}

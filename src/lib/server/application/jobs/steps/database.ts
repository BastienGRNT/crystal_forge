/** Sauvegarde et restauration de la base d'un projet (dumps SQL gzip sur le CT). */
import { isSqlDbKind } from '$lib/domain/compose-analysis';
import { backupName, isValidBackupName, type BackupReason } from '$lib/domain/database';
import { GENERATED_COMPOSE_FILE } from '$lib/domain/workflow';
import type { ProjectRow } from '$server/infrastructure/db/schema';
import { DbCommand, type DbLocation } from '../../gateways';
import type { StepDefinition } from '../types';
import { runnerRepoDir } from './common';

/** Emplacement de la base du projet, ou erreur claire si elle n'est pas configurée. */
export function dbLocation(p: ProjectRow): DbLocation {
	if (!p.dbService || !isSqlDbKind(p.dbKind)) {
		throw new Error('Aucune base PostgreSQL / MySQL / MariaDB configurée pour ce projet (onglet Base de données).');
	}
	return {
		repoDir: runnerRepoDir(p),
		workdir: p.workdir,
		composeFile: p.deployMode === 'dockerfile' ? GENERATED_COMPOSE_FILE : (p.composeFile ?? 'docker-compose.yml'),
		service: p.dbService,
		kind: p.dbKind,
		slug: p.slug
	};
}

export const dbBackupStep: StepDefinition = {
	key: 'db_backup',
	label: 'Sauvegarde de la base',
	async run(ctx) {
		const p = ctx.project();
		if (!p.ip) throw new Error('Le projet n’a pas d’IP.');
		const loc = dbLocation(p);
		const reason: BackupReason = ctx.params.restore ? 'pre-restore' : ((ctx.params.reason as BackupReason | undefined) ?? 'manual');
		const name = (ctx.state.name as string | undefined) ?? backupName(reason);
		ctx.state.name = name;
		ctx.save();
		ctx.log('info', `Dump de « ${loc.service} » (${loc.kind}) → ${name}`);
		const res = await ctx.services.shell.dbWrite({ ip: p.ip, sshHostKey: p.sshHostKey }, DbCommand.backup(loc, name), `Sauvegarder la base « ${loc.service} » → ${name}`);
		if (res.code !== 0) throw new Error(`Échec du dump (code ${res.code}) : ${res.stderr.trim().slice(-500) || 'aucun détail'}`);
		const size = Number(res.stdout.trim().split('\n').pop());
		ctx.log('success', `Sauvegarde créée : ${name}${Number.isFinite(size) && size > 0 ? ` (${Math.round(size / 1024)} Ko)` : ''}.`);
	}
};

export const dbRestoreStep: StepDefinition = {
	key: 'db_restore',
	label: 'Restauration',
	async run(ctx) {
		const p = ctx.project();
		if (!p.ip) throw new Error('Le projet n’a pas d’IP.');
		const loc = dbLocation(p);
		const name = String(ctx.params.restore ?? '');
		if (!isValidBackupName(name)) throw new Error(`Sauvegarde invalide : ${name}`);
		const safety = ctx.stepState('db_backup').name;
		ctx.log('warn', `Restauration de ${name} dans « ${loc.service} » : les tables existantes sont remplacées.${safety ? ` État actuel sauvegardé dans ${String(safety)}.` : ''}`);
		const res = await ctx.services.shell.dbWrite({ ip: p.ip, sshHostKey: p.sshHostKey }, DbCommand.restore(loc, name), `Restaurer ${name} dans la base « ${loc.service} »`);
		if (res.code !== 0) throw new Error(`Échec de la restauration (code ${res.code}) : ${res.stderr.trim().slice(-500) || 'aucun détail'}`);
		ctx.log('success', `Base restaurée depuis ${name}.`);
	}
};

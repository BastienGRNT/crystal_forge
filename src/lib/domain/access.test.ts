import { describe, expect, it } from 'vitest';
import { formActionName, levelAtLeast, requirementFor } from './access';

describe('levelAtLeast', () => {
	it('classe lecture < déploiement < édition', () => {
		expect(levelAtLeast('edit', 'deploy')).toBe(true);
		expect(levelAtLeast('read', 'deploy')).toBe(false);
		expect(levelAtLeast(null, 'read')).toBe(false);
	});
});

describe('requirementFor', () => {
	it('ferme par défaut tout ce qui n’est pas listé', () => {
		expect(requirementFor('GET', '/settings').kind).toBe('admin');
		expect(requirementFor('GET', '/server').kind).toBe('admin');
		expect(requirementFor('GET', '/users').kind).toBe('admin');
		expect(requirementFor('GET', '/projects/new').kind).toBe('admin');
		expect(requirementFor('GET', '/api/github/repos').kind).toBe('admin');
		expect(requirementFor('GET', '/').kind).toBe('admin');
		expect(requirementFor('GET', '/une-page-future').kind).toBe('admin');
	});

	it('ouvre les listes (filtrées côté serveur) à tout connecté', () => {
		expect(requirementFor('GET', '/projects').kind).toBe('any');
		expect(requirementFor('GET', '/jobs').kind).toBe('any');
	});

	it('lecture d’un projet : niveau read, sauf variables/base (edit) et réglages (admin)', () => {
		expect(requirementFor('GET', '/projects/crm')).toEqual({ kind: 'project', slug: 'crm', level: 'read' });
		expect(requirementFor('GET', '/projects/crm/deployments')).toEqual({ kind: 'project', slug: 'crm', level: 'read' });
		expect(requirementFor('GET', '/projects/crm/variables')).toEqual({ kind: 'project', slug: 'crm', level: 'edit' });
		expect(requirementFor('GET', '/projects/crm/database')).toEqual({ kind: 'project', slug: 'crm', level: 'edit' });
		expect(requirementFor('GET', '/projects/crm/settings').kind).toBe('admin');
	});

	it('actions de formulaire : niveau selon l’action', () => {
		expect(requirementFor('POST', '/projects/crm/deployments', '?/redeploy')).toEqual({ kind: 'project', slug: 'crm', level: 'deploy' });
		expect(requirementFor('POST', '/projects/crm/variables', '?/save')).toEqual({ kind: 'project', slug: 'crm', level: 'edit' });
		expect(requirementFor('POST', '/projects/crm/domains', '?/add')).toEqual({ kind: 'project', slug: 'crm', level: 'edit' });
		expect(requirementFor('POST', '/projects/crm/container', '?/power')).toEqual({ kind: 'project', slug: 'crm', level: 'edit' });
	});

	it('actions sensibles ou inconnues : admin', () => {
		expect(requirementFor('POST', '/projects/crm/container', '?/resize').kind).toBe('admin');
		expect(requirementFor('POST', '/projects/crm/settings', '?/delete').kind).toBe('admin');
		expect(requirementFor('POST', '/projects/crm/deployments', '?/nouvelle-action').kind).toBe('admin');
		expect(requirementFor('POST', '/projects/crm/deployments').kind).toBe('admin');
	});

	it('ignore le suffixe /__data.json et la barre finale', () => {
		expect(requirementFor('GET', '/projects/crm/variables/__data.json')).toEqual({ kind: 'project', slug: 'crm', level: 'edit' });
		expect(requirementFor('GET', '/projects/crm/')).toEqual({ kind: 'project', slug: 'crm', level: 'read' });
	});

	it('API des projets et jobs', () => {
		expect(requirementFor('GET', '/api/projects/crm/logs')).toEqual({ kind: 'project', slug: 'crm', level: 'read' });
		expect(requirementFor('GET', '/api/projects/crm/db/browse')).toEqual({ kind: 'project', slug: 'crm', level: 'edit' });
		expect(requirementFor('GET', '/api/jobs/12/events')).toEqual({ kind: 'job', id: 12, level: 'read' });
		expect(requirementFor('GET', '/jobs/12')).toEqual({ kind: 'job', id: 12, level: 'read' });
		expect(requirementFor('POST', '/jobs/12', '?/confirm')).toEqual({ kind: 'job', id: 12, level: 'deploy' });
	});
});

describe('formActionName', () => {
	it('lit le nom de l’action', () => {
		expect(formActionName('?/save')).toBe('save');
		expect(formActionName('?/save&redirectTo=x')).toBe('save');
		expect(formActionName('')).toBe('');
	});
});

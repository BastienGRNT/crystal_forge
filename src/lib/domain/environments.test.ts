import { describe, expect, it } from 'vitest';
import { devSlugFor, validateEnvironment, workflowPathFor, type EnvironmentSubject } from './environments';

const prod: EnvironmentSubject = { slug: 'pharm', repo: 'me/pharm', branch: 'main', environment: 'production' };
const dev = (over: Partial<EnvironmentSubject> = {}): EnvironmentSubject => ({ slug: 'pharm-dev', repo: 'me/pharm', branch: 'dev', environment: 'development', ...over });

describe('environnements', () => {
	it('autorise un dev à côté de la prod existante', () => {
		expect(validateEnvironment(dev(), [prod])).toEqual([]);
	});
	it('refuse main (ou master) pour le dev : cela déploierait la prod', () => {
		expect(validateEnvironment(dev({ branch: 'main' }), [])).not.toEqual([]);
		expect(validateEnvironment(dev({ branch: 'Master' }), [])).not.toEqual([]);
	});
	it('impose main à la production et interdit le suffixe -dev', () => {
		expect(validateEnvironment({ ...prod, branch: 'develop' }, [])).not.toEqual([]);
		expect(validateEnvironment({ ...prod, slug: 'pharm-dev' }, [])).not.toEqual([]);
	});
	it('impose le suffixe -dev au développement', () => {
		expect(validateEnvironment(dev({ slug: 'pharm2' }), [])).not.toEqual([]);
	});
	it('refuse un second serveur du même environnement ou la même branche deux fois', () => {
		expect(validateEnvironment(dev(), [dev({ slug: 'autre-dev', branch: 'x' })])).not.toEqual([]);
		expect(validateEnvironment(dev({ branch: 'dev' }), [{ ...prod, branch: 'dev' }])).not.toEqual([]);
	});
	it('ne mélange pas les dépôts et sépare les fichiers de workflow', () => {
		expect(validateEnvironment(dev(), [{ ...prod, repo: 'me/autre' }])).toEqual([]);
		expect(workflowPathFor('production')).toBe('.github/workflows/forge-deploy.yml');
		expect(workflowPathFor('development')).toBe('.github/workflows/forge-deploy-dev.yml');
		expect(devSlugFor('pharm')).toBe('pharm-dev');
		expect(devSlugFor('pharm-dev')).toBe('pharm-dev');
	});
});

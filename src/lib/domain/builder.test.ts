import { describe, expect, it } from 'vitest';
import { assertDeployDir, assertWorkdir, buildDir, missingVariables, newDeployDir, parseComposeConfig, composeProjectName } from './builder';


describe('CT de build', () => {
	it("n'écrit que sous /home/github et refuse les remontées", () => {
		expect(newDeployDir('mon-app')).toBe('/home/github/forge/mon-app');
		expect(assertDeployDir('/home/github/actions-runner/_work/a/a')).toBeTruthy();
		for (const bad of ['/', '/home/github', '/home/github/../root', '/etc/x/y', "/home/github/a'b"]) expect(() => assertDeployDir(bad)).toThrow();
		expect(assertWorkdir('')).toBe('.');
		expect(assertWorkdir('apps/web')).toBe('apps/web');
		for (const bad of ['../x', '/abs', 'a/../../b', 'a b']) expect(() => assertWorkdir(bad)).toThrow();
		expect(() => buildDir('../x')).toThrow();
	});
	it('liste les images construites', () => {
		const cfg = JSON.stringify({ name: 'monapp', services: { app: { build: { context: '.' } }, api: { build: {}, image: 'ghcr.io/x/api:1' }, db: { image: 'postgres:17' } } });
		expect(parseComposeConfig(`WARN bruit\n${cfg}`)).toEqual({
			name: 'monapp',
			built: [
				{ service: 'app', image: 'monapp-app' },
				{ service: 'api', image: 'ghcr.io/x/api:1' }
			]
		});
		expect(() => parseComposeConfig(JSON.stringify({ name: 'x', services: { a: { build: {}, image: 'x; rm -rf /' } } }))).toThrow();
	});
	it('repère les variables manquantes', () => {
		const out = 'error while interpolating services.backup.environment.X: required variable BACKUP_BUCKET is missing a value: set it\nWARN The "API_KEY" variable is not set. Defaulting to a blank string.';
		expect(missingVariables(out)).toEqual(['BACKUP_BUCKET', 'API_KEY']);
	});
});

describe('composeProjectName', () => {
	it('reprend le nom de dossier comme docker compose (images et volumes inchangés)', () => {
		expect(composeProjectName('/home/github/actions-runner/_work/My.App/My.App')).toBe('myapp');
		expect(composeProjectName('/srv/forge/app_v2/')).toBe('app_v2');
		expect(composeProjectName('/srv/-x')).toBe('x');
	});
});

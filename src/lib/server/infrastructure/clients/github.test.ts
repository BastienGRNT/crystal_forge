import { describe, expect, it } from 'vitest';
import { explainGithubError } from './github';

const NOT_ACCESSIBLE = 'Resource not accessible by personal access token';

describe('explainGithubError', () => {
	it("jeton d'enregistrement refusé : nomme la permission Administration et l'accès au dépôt", () => {
		const msg = explainGithubError({ status: 403, message: NOT_ACCESSIBLE, acceptedPermissions: 'administration=write' }, "jeton d'enregistrement du runner");
		expect(msg).toContain('Administration : Read and write');
		expect(msg).toContain('Repository access');
		expect(msg).toContain('administration=write');
	});

	it('retrait du runner : même explication', () => {
		expect(explainGithubError({ status: 403, message: NOT_ACCESSIBLE }, 'retrait du runner 12')).toContain('Administration');
	});

	it('autre opération : conseil générique', () => {
		const msg = explainGithubError({ status: 403, message: NOT_ACCESSIBLE }, 'secret du dépôt');
		expect(msg).not.toContain('Administration');
		expect(msg).toContain('permissions du jeton');
	});

	it('401 : jeton invalide', () => {
		expect(explainGithubError({ status: 401, message: 'Bad credentials' }, 'identification')).toBe('identification : jeton invalide ou expiré');
	});
});

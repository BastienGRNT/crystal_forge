import { describe, expect, it } from 'vitest';
import { sensitiveEnvValues } from './env-template';

describe('sensitiveEnvValues', () => {
	it('masque les clés sensibles, pas les valeurs ordinaires', () => {
		const values = sensitiveEnvValues('NODE_ENV=production\nDB_HOST=postgres\nDB_PASSWORD=hunter2\nAPI_KEY=abc\n');
		expect(values).toEqual(['hunter2', 'abc']);
	});

	it('masque le mot de passe des URL de connexion', () => {
		expect(sensitiveEnvValues('DATABASE_URL=postgres://notes:s3cr3t-pw@db:5432/notes')).toContain('s3cr3t-pw');
		expect(sensitiveEnvValues('REDIS_URL=redis://cache:6379')).toEqual([]);
	});

	it('masque les valeurs qui ressemblent à un secret généré, quelle que soit la clé', () => {
		expect(sensitiveEnvValues('API_SIGNATURE=f0rge-t3st-9QzX7mKp2LwR5vN8\nORIGIN=https://notes.example.com\nLABEL=un libellé 2024 assez long')).toEqual([
			'f0rge-t3st-9QzX7mKp2LwR5vN8'
		]);
	});
});

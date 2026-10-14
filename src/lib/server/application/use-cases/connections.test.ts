import { describe, expect, it } from 'vitest';
import { poolAuditFix, templateCheck } from './connections';

const base = { templateId: 900, pool: 'forge', tokenId: 'forge@pve!forge' };
const tpl = (pool: string | null) => ({ name: 'tpl-docker-runner', template: true, pool });

describe('templateCheck (Pool.Audit)', () => {
	it('template dans le pool : ok', () => {
		expect(templateCheck({ ...base, tpl: tpl('forge'), poolAudit: true, poolMembers: [900] }).status).toBe('ok');
	});

	it('champ pool masqué faute de Pool.Audit : message précis avec la commande de correction', () => {
		const c = templateCheck({ ...base, tpl: tpl(null), poolAudit: false, poolMembers: null });
		expect(c.status).toBe('error');
		expect(c.detail).toContain('Pool.Audit');
		expect(c.detail).toContain("pveum acl modify /pool/forge --roles PVEPoolUser --users forge@pve --tokens 'forge@pve!forge' --propagate 1");
	});

	it('champ pool absent alors que /pools/forge liste le template : même diagnostic', () => {
		const c = templateCheck({ ...base, tpl: tpl(null), poolAudit: true, poolMembers: [900] });
		expect(c.detail).toContain('PVEPoolUser');
	});

	it('vraiment hors du pool', () => {
		const c = templateCheck({ ...base, tpl: tpl(null), poolAudit: true, poolMembers: [] });
		expect(c.detail).toContain('Hors du pool');
	});

	it('commande de correction', () => {
		expect(poolAuditFix('forge', 'forge@pve!forge')).toBe("pveum acl modify /pool/forge --roles PVEPoolUser --users forge@pve --tokens 'forge@pve!forge' --propagate 1");
	});
});

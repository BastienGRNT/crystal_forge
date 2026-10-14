import { describe, expect, it } from 'vitest';
import { hasFirewallFlag, parseInternetProbe, withFirewallFlag } from './firewall';

describe('accès Internet des CT avec pare-feu', () => {
	it('détecte firewall=1 sur net0', () => {
		expect(hasFirewallFlag('name=eth0,bridge=nat,firewall=1,ip=10.10.10.60/24')).toBe(true);
		expect(hasFirewallFlag('name=eth0,bridge=nat,ip=10.10.10.60/24')).toBe(false);
		expect(hasFirewallFlag('name=eth0,firewall=0')).toBe(false);
		expect(hasFirewallFlag(withFirewallFlag('name=eth0,bridge=nat'))).toBe(true);
	});

	it('toute réponse HTTP prouve l’accès, « 000 » non (NAT cassé sans zone conntrack)', () => {
		expect(parseInternetProbe(0, '200')).toBe('ok');
		expect(parseInternetProbe(0, '403')).toBe('ok');
		expect(parseInternetProbe(28, '000')).toBe('down');
		expect(parseInternetProbe(6, '')).toBe('down');
		expect(parseInternetProbe(127, '')).toBe('unknown');
	});
});

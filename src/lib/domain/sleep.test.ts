import { describe, expect, it } from 'vitest';
import { assertCanToggleSleep, idleRuleCommand, isIdle, nextActivity, parseIdleCounter, WAKE_PORT } from './sleep';

describe('mise en veille', () => {
	it('lit le compteur de connexions', () => {
		const out = `Chain PREROUTING (policy ACCEPT 0 packets, 0 bytes)
    pkts      bytes target     prot opt in     out     source               destination
      42     2520            6    --  *      *       0.0.0.0/0            0.0.0.0/0            tcp dpt:3000 flags:0x17/0x02 /* forge-idle:3000 */`;
		expect(parseIdleCounter(out, 3000)).toBe(42);
		expect(parseIdleCounter(out, 8080)).toBeNull();
		expect(idleRuleCommand(3000)).toBe('iptables -w -t mangle -C PREROUTING -p tcp --dport 3000 --syn -m comment --comment forge-idle:3000 2>/dev/null || iptables -w -t mangle -A PREROUTING -p tcp --dport 3000 --syn -m comment --comment forge-idle:3000');
		expect(() => idleRuleCommand(0)).toThrow();
	});
	it("ne s'endort qu'après le délai sans nouvelle connexion", () => {
		let a = nextActivity(undefined, 5, 0);
		a = nextActivity(a, 5, 20 * 60_000);
		expect(isIdle(a, 30, 29 * 60_000)).toBe(false);
		expect(isIdle(a, 30, 30 * 60_000)).toBe(true);
		expect(isIdle(nextActivity(a, 6, 31 * 60_000), 30, 31 * 60_000)).toBe(false);
		expect(isIdle(a, null, 10 ** 9)).toBe(false);
		expect(isIdle(a, 0, 10 ** 9)).toBe(false);
	});
	it("ne bascule NPM qu'entre le projet et la page de réveil", () => {
		const t = { projectIp: '10.10.10.60', appPort: 3000, wakeHost: '10.10.10.150' };
		const app = { forwardHost: '10.10.10.60', forwardPort: 3000 };
		const wake = { forwardHost: '10.10.10.150', forwardPort: WAKE_PORT };
		expect(() => assertCanToggleSleep({ id: 1, ...app }, wake, t)).not.toThrow();
		expect(() => assertCanToggleSleep({ id: 1, ...wake }, app, t)).not.toThrow();
		expect(() => assertCanToggleSleep({ id: 1, forwardHost: '10.10.10.61', forwardPort: 3000 }, wake, t)).toThrow();
		expect(() => assertCanToggleSleep({ id: 1, ...app }, { forwardHost: '10.10.10.1', forwardPort: 8006 }, t)).toThrow();
	});
});

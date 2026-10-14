import { fail } from '@sveltejs/kit';
import { forge } from '$server/container';
import { errorMessage, UserFacingError } from '$lib/domain/errors';
import { isSettingKey, type SettingKey } from '$server/application/settings';
import { generateForgeKeyPair, publicKeyFingerprint } from '$server/infrastructure/clients/ssh';
import { ovhCreateTokenUrl } from '$server/infrastructure/clients/ovh-signature';
import { isIpv4 } from '$lib/domain/network';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const f = forge();
	const view = f.settings.publicView();
	const zones = await f.wizard.zones();
	const zoneList = zones.zones.length ? zones.zones : ['bastiengrnt.fr', 'pharmagaia.com'];
	const pub = f.settings.get('ssh.publicKey');
	return {
		...view,
		mode: f.config.mode,
		dryRun: f.isDryRun(),
		dryRunEnvDefault: f.config.dryRunDefault,
		allowedSources: f.config.allowedSources,
		masterKeyFallback: f.config.masterKeyIsDevFallback,
		sshFingerprint: pub ? publicKeyFingerprint(pub) : null,
		ovhTokenUrl: ovhCreateTokenUrl(f.settings.get('ovh.endpoint'), zoneList, true),
		ovhTokenUrlNoDelete: ovhCreateTokenUrl(f.settings.get('ovh.endpoint'), zoneList, false),
		audit: f.guard.recentAudit(30),
		update: await f.selfUpdate.status().catch((err) => ({ error: errorMessage(err) }))
	};
};

function validate(values: Partial<Record<SettingKey, string>>) {
	for (const k of ['network.publicIp', 'network.gateway', 'network.ipStart', 'network.ipEnd', 'network.npmIp', 'network.forgeIp'] as const) {
		if (values[k] !== undefined && values[k] !== '' && !isIpv4(values[k] as string)) throw new UserFacingError(`${k} : IPv4 invalide`);
	}
	const ns = values['network.nameserver'];
	if (ns && !ns.split(/\s+/).every(isIpv4)) throw new UserFacingError('network.nameserver : IPv4 séparées par des espaces');
	for (const k of ['ctid.min', 'ctid.max', 'proxmox.templateId', 'network.cidr'] as const) {
		if (values[k] !== undefined && values[k] !== '' && !/^\d+$/.test(values[k] as string)) throw new UserFacingError(`${k} : nombre attendu`);
	}
	if (values['dashboard.repoMap']) {
		try {
			JSON.parse(values['dashboard.repoMap']);
		} catch {
			throw new UserFacingError('Correspondance CT → dépôt : JSON invalide');
		}
	}
	if (values['ssh.privateKey'] !== undefined) throw new UserFacingError('La clé SSH se génère avec le bouton dédié.');
	if (values['runtime.dryRun'] !== undefined) throw new UserFacingError('Réglage interne.');
}

export const actions: Actions = {
	save: async ({ request }) => {
		const f = forge();
		const d = await request.formData();
		const values: Partial<Record<SettingKey, string>> = {};
		for (const [k, v] of d.entries()) {
			if (isSettingKey(k) && typeof v === 'string') values[k] = v.trim();
		}
		try {
			validate(values);
			f.settings.set(values);
		} catch (err) {
			return fail(400, { section: String(d.get('_section') ?? ''), error: errorMessage(err) });
		}
		return { section: String(d.get('_section') ?? ''), saved: true };
	},
	test: async () => {
		return { report: await forge().connections.run() };
	},
	checkUpdate: async () => {
		try {
			return { updateCheck: await forge().selfUpdate.check() };
		} catch (err) {
			return fail(400, { section: 'update', error: errorMessage(err) });
		}
	},
	applyUpdate: async () => {
		try {
			return { updateRequested: await forge().selfUpdate.request() };
		} catch (err) {
			return fail(400, { section: 'update', error: errorMessage(err) });
		}
	},
	generateKey: async () => {
		const kp = generateForgeKeyPair('forge');
		forge().settings.set({ 'ssh.privateKey': kp.privateKey, 'ssh.publicKey': kp.publicKey });
		return { keyGenerated: true };
	},
	dryRun: async ({ request }) => {
		const f = forge();
		try {
			f.setDryRun((await request.formData()).get('value') === 'true');
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		return { saved: true };
	},
	resetMock: async () => {
		try {
			forge().resetMock();
		} catch (err) {
			return fail(400, { error: errorMessage(err) });
		}
		return { reset: true };
	},
	password: async ({ request }) => {
		const d = await request.formData();
		const next = String(d.get('next') ?? '');
		if (next !== String(d.get('confirm') ?? '')) return fail(400, { section: 'account', error: 'Les deux mots de passe ne correspondent pas.' });
		try {
			await forge().auth.changePassword(String(d.get('current') ?? ''), next);
		} catch (err) {
			return fail(400, { section: 'account', error: errorMessage(err) });
		}
		return { section: 'account', passwordChanged: true };
	}
};

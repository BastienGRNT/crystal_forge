import { redirect, type Handle, type HandleServerError, type ServerInit } from '@sveltejs/kit';
import { forge } from '$server/container';
import { SESSION_COOKIE } from '$server/application/use-cases/auth';
import { getConfig } from '$server/infrastructure/config';
import { inCidr, isIpv4 } from '$lib/domain/network';

export const init: ServerInit = async () => {
	forge();
};

function normalizeIp(raw: string): string {
	if (raw.startsWith('::ffff:')) return raw.slice(7);
	return raw;
}

function isAllowed(ip: string, cidrs: string[]): boolean {
	if (ip === '::1') return cidrs.some((c) => c.startsWith('::1'));
	if (!isIpv4(ip)) return false;
	return cidrs.some((c) => !c.includes(':') && inCidr(ip, c));
}

const PUBLIC_PATHS = ['/login', '/setup'];

export const handle: Handle = async ({ event, resolve }) => {
	const f = forge();
	const config = getConfig();
	let ip = '';
	try {
		ip = normalizeIp(event.getClientAddress());
	} catch {
		// Connexion déjà fermée : adresse inconnue → refus.
	}
	event.locals.clientIp = ip;

	// 1. Accès réseau : uniquement Tailscale / hôte (en plus du pare-feu du CT 150).
	if (!isAllowed(ip, config.allowedSources)) {
		console.warn(`[forge] Accès refusé depuis ${ip} ${event.url.pathname}`);
		return new Response('Accès refusé : Forge n’est accessible que via Tailscale.', { status: 403 });
	}

	// 2. Authentification.
	const path = event.url.pathname;
	const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
	if (f.auth.needsSetup() && path !== '/setup') redirect(303, '/setup');

	const session = f.auth.validate(event.cookies.get(SESSION_COOKIE));
	event.locals.authenticated = !!session;
	if (session) {
		event.cookies.set(SESSION_COOKIE, event.cookies.get(SESSION_COOKIE) as string, {
			path: '/',
			httpOnly: true,
			sameSite: 'strict',
			secure: config.secureCookies,
			expires: new Date(session.expiresAt)
		});
	}
	if (!session && !isPublic) {
		if (path.startsWith('/api/')) return new Response(JSON.stringify({ message: 'Non authentifié' }), { status: 401, headers: { 'content-type': 'application/json' } });
		redirect(303, `/login?next=${encodeURIComponent(path + event.url.search)}`);
	}

	const response = await resolve(event);
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'no-referrer');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	return response;
};

export const handleError: HandleServerError = ({ error, event }) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`[forge] ${event.request.method} ${event.url.pathname} :`, error);
	return { message: forge().redactor.redact(message) };
};

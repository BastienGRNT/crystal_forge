import { error, redirect, type Handle, type HandleServerError, type RequestEvent, type ServerInit } from '@sveltejs/kit';
import { forge } from '$server/container';
import { SESSION_COOKIE } from '$server/application/use-cases/auth';
import { getConfig } from '$server/infrastructure/config';
import { inCidr, isIpv4 } from '$lib/domain/network';
import { levelAtLeast, normalizePath, requirementFor } from '$lib/domain/access';
import type { SessionUser } from '$server/application/use-cases/auth';

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

const PUBLIC_PATHS = ['/login', '/setup', '/reset'];

/**
 * Droits d'un collaborateur, vérifiés sur CHAQUE requête (page, action de formulaire, API).
 * Renvoie la réponse de refus, ou null si la requête est permise. L'admin passe toujours.
 */
function authorize(user: SessionUser, event: RequestEvent): Response | null {
	if (user.role === 'admin') return null;
	const f = forge();
	const req = requirementFor(event.request.method, event.url.pathname, event.url.search);
	let allowed = false;
	if (req.kind === 'any') allowed = true;
	else if (req.kind === 'project' || req.kind === 'job') {
		let projectId: number | null | undefined;
		if (req.kind === 'project') {
			const p = f.repos.projects.bySlug(req.slug);
			projectId = p && p.status !== 'deleted' ? p.id : null;
		} else {
			projectId = f.repos.jobs.get(req.id)?.projectId;
		}
		allowed = projectId != null && levelAtLeast(f.auth.levelFor(user, projectId), req.level);
	}
	if (allowed) return null;

	const path = normalizePath(event.url.pathname);
	const isGet = event.request.method === 'GET' || event.request.method === 'HEAD';
	if (isGet && path === '/' && !event.url.pathname.endsWith('__data.json')) redirect(303, '/projects');
	const message = 'Accès refusé : vos droits ne permettent pas cette action.';
	if (path.startsWith('/api/')) return new Response(JSON.stringify({ message }), { status: 403, headers: { 'content-type': 'application/json' } });
	error(403, message);
}

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
	event.locals.user = session?.user ?? null;
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

	if (session) {
		const denied = authorize(session.user, event);
		if (denied) return denied;
	}

	const response = await resolve(event);
	// Journal : qui a fait quelle écriture (jamais le contenu des formulaires).
	if (session && event.request.method !== 'GET' && event.request.method !== 'HEAD') {
		f.audit.add({
			userId: session.user.id,
			username: session.user.username,
			method: event.request.method,
			path: (event.url.pathname + event.url.search).slice(0, 300),
			status: response.status,
			ip
		});
	}
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

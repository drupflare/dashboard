import { type H3Event, defineEventHandler, getResponseHeader, setResponseHeader } from 'h3';

const TURNSTILE = 'https://challenges.cloudflare.com';
const ENFORCED_CSP =
	"base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'";
const REPORT_ONLY_CSP = [
	"default-src 'self'",
	`script-src 'self' 'unsafe-inline' ${TURNSTILE}`,
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"font-src 'self' https://fonts.gstatic.com",
	"connect-src 'self'",
	`frame-src ${TURNSTILE}`
].join('; ');

export function applySecurityHeaders(event: H3Event, production: boolean): void {
	if (!production) return;
	setResponseHeader(event, 'Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	setResponseHeader(event, 'X-Content-Type-Options', 'nosniff');
	setResponseHeader(event, 'Referrer-Policy', 'strict-origin-when-cross-origin');
	setResponseHeader(
		event,
		'Permissions-Policy',
		'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
	);
	// this runs before the route, so a route's own CSP replaces the enforced one by name
	if (getResponseHeader(event, 'Content-Security-Policy')) return;
	setResponseHeader(event, 'Content-Security-Policy', ENFORCED_CSP);
	if (!isApiPath(event.path)) {
		setResponseHeader(event, 'Content-Security-Policy-Report-Only', REPORT_ONLY_CSP);
	}
}

function isApiPath(path: string): boolean {
	const pathname = new URL(path, 'http://localhost').pathname;
	return pathname === '/api' || pathname.startsWith('/api/');
}

export default defineEventHandler((event) => applySecurityHeaders(event, !import.meta.dev));

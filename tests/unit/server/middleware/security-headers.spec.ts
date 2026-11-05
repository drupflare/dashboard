import type { H3Event } from 'h3';
import { describe, expect, it } from 'vitest';
import { applySecurityHeaders } from '../../../../src/server/middleware/00.security-headers';

function fakeEvent(path: string, existing: Record<string, string> = {}) {
	const headers = new Map<string, string>(
		Object.entries(existing).map(([name, value]) => [name.toLowerCase(), value])
	);
	const res = {
		setHeader(name: string, value: string) {
			headers.set(name.toLowerCase(), value);
		},
		getHeader(name: string) {
			return headers.get(name.toLowerCase());
		},
		removeHeader(name: string) {
			headers.delete(name.toLowerCase());
		}
	};
	const event = { path, node: { res } } as unknown as H3Event;
	return { event, headers };
}

const STATIC = {
	'strict-transport-security': 'max-age=31536000; includeSubDomains',
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
};

describe('applySecurityHeaders in production', () => {
	it('sets the static headers and both CSP headers on a page', () => {
		const { event, headers } = fakeEvent('/');
		applySecurityHeaders(event, true);
		for (const [name, value] of Object.entries(STATIC)) expect(headers.get(name)).toBe(value);
		expect(headers.get('content-security-policy')).toBe(
			"base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'"
		);
		expect(headers.get('content-security-policy-report-only')).toMatch(/^default-src 'self';/);
	});

	it('keeps HSTS without preload', () => {
		const { event, headers } = fakeEvent('/');
		applySecurityHeaders(event, true);
		expect(headers.get('strict-transport-security')).not.toContain('preload');
	});

	it('allows Turnstile in the report-only script and frame sources', () => {
		const { event, headers } = fakeEvent('/');
		applySecurityHeaders(event, true);
		const report = headers.get('content-security-policy-report-only') ?? '';
		expect(report).toContain(
			"script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com"
		);
		expect(report).toContain('frame-src https://challenges.cloudflare.com');
	});

	it('leaves the report-only policy off the API', () => {
		for (const path of ['/api/health', '/api', '/api/v1/sites?page=2']) {
			const { event, headers } = fakeEvent(path);
			applySecurityHeaders(event, true);
			expect(headers.has('content-security-policy-report-only')).toBe(false);
			expect(headers.get('content-security-policy')).toBeDefined();
		}
	});

	it('does not treat a path that only starts with api as the API', () => {
		const { event, headers } = fakeEvent('/apiary/x');
		applySecurityHeaders(event, true);
		expect(headers.has('content-security-policy-report-only')).toBe(true);
	});

	it('skips both CSP headers when a CSP is already set', () => {
		const existing = { 'Content-Security-Policy': "default-src 'none'" };
		const { event, headers } = fakeEvent('/docs', existing);
		applySecurityHeaders(event, true);
		expect(headers.get('content-security-policy')).toBe("default-src 'none'");
		expect(headers.has('content-security-policy-report-only')).toBe(false);
		for (const [name, value] of Object.entries(STATIC)) expect(headers.get(name)).toBe(value);
	});
});

describe('applySecurityHeaders outside production', () => {
	it('sets nothing in development', () => {
		const { event, headers } = fakeEvent('/');
		applySecurityHeaders(event, false);
		expect(headers.size).toBe(0);
	});
});

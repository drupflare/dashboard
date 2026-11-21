import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	buildSpoolManifest,
	digest,
	isDeclaredPage,
	routeOfHtml
} from '../../../scripts/spool-manifest';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('spool static routes', () => {
	it('declares docs, trust and demo pages but never the admin docs, api or login', () => {
		expect(isDeclaredPage('/docs')).toBe(true);
		expect(isDeclaredPage('/docs/guides/billing/plans')).toBe(true);
		expect(isDeclaredPage('/trust')).toBe(true);
		expect(isDeclaredPage('/demo')).toBe(true);
		expect(isDeclaredPage('/docs/admin/on-call')).toBe(false);
		expect(isDeclaredPage('/docs/administrators')).toBe(true);
		expect(isDeclaredPage('/login')).toBe(false);
		expect(isDeclaredPage('/api/v1/me')).toBe(false);
	});

	it('maps each prerendered html file to its route', () => {
		expect(routeOfHtml('docs/index.html')).toBe('/docs');
		expect(routeOfHtml('docs/guides/billing/plans/index.html')).toBe(
			'/docs/guides/billing/plans'
		);
		expect(routeOfHtml('docs/guides/billing/plans.html')).toBe('/docs/guides/billing/plans');
		expect(routeOfHtml('trust.html')).toBe('/trust');
		expect(routeOfHtml('index.html')).toBeNull();
		expect(routeOfHtml('docs/admin/on-call/index.html')).toBeNull();
	});

	it('uses sha256 for pages and build assets and sha384 for the page runtime', () => {
		const sha256 = `sha256-${createHash('sha256').update(bytes('x')).digest('base64')}`;
		expect(digest(bytes('x'), 'sha256')).toBe(sha256);
		expect(digest(bytes('x'), 'sha384').startsWith('sha384-')).toBe(true);
	});

	it('builds a schema 1 manifest with one static route per declared file', () => {
		const manifest = buildSpoolManifest([
			{ path: 'docs/guides/billing/plans/index.html', bytes: bytes('plans') },
			{ path: 'docs/admin/on-call/index.html', bytes: bytes('secret') },
			{ path: '_nuxt/entry.js', bytes: bytes('js') },
			{ path: 'client.js', bytes: bytes('client') },
			{ path: 'spool-sw.js', bytes: bytes('sw') },
			{ path: 'favicon.png', bytes: bytes('png') }
		]);
		expect(manifest.schema).toBe(1);
		expect(manifest.routes.map((route) => route.pattern)).toEqual([
			'/_nuxt/entry.js',
			'/client.js',
			'/docs/guides/billing/plans'
		]);
		const page = manifest.routes.find(
			(route) => route.pattern === '/docs/guides/billing/plans'
		);
		expect(page).toEqual({
			pattern: '/docs/guides/billing/plans',
			strategy: 'static',
			version: digest(bytes('plans'), 'sha256'),
			freshness: { maxStale: 3600, mode: 'soft' }
		});
		expect(manifest.routes.find((route) => route.pattern === '/client.js')!.version).toBe(
			digest(bytes('client'), 'sha384')
		);
	});
});

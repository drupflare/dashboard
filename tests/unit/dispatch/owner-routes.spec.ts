import { describe, expect, it } from 'vitest';
import { OWNER_ROUTE_PATHS } from '../../../contracts/src/owner-routes';
import { isOwnerRequest, OWNER_ROUTES } from '../../../dispatch/src/owner-routes';

const request = (path: string, authorization?: string) =>
	new Request(`https://site.drupflare.app${path}`, {
		headers: authorization === undefined ? {} : { authorization }
	});

describe('owner routes', () => {
	it('keeps the dispatch copy equal to the list synced into contracts', () => {
		expect([...OWNER_ROUTES].sort()).toEqual([...OWNER_ROUTE_PATHS].sort());
		expect(new Set(OWNER_ROUTE_PATHS).size).toBe(OWNER_ROUTE_PATHS.length);
	});

	it('names the routes that recovery and export need', () => {
		for (const path of ['/export', '/restore', '/restore-parts', '/pitr', '/serve-stats']) {
			expect(OWNER_ROUTES.has(path), path).toBe(true);
		}
	});

	it('leaves out the public routes and the diagnostics-only routes', () => {
		for (const path of ['/serve', '/firstrun', '/oidc', '/githook', '/sql', '/php', '/files']) {
			expect(OWNER_ROUTES.has(path), path).toBe(false);
		}
	});

	it('takes only absolute paths with no trailing slash', () => {
		for (const path of OWNER_ROUTES) {
			expect(path.startsWith('/')).toBe(true);
			expect(path.endsWith('/')).toBe(false);
		}
	});

	it('needs both a bearer credential and an owner route', () => {
		expect(isOwnerRequest(request('/export', 'Bearer abc'))).toBe(true);
		expect(isOwnerRequest(request('/export', 'bearer  abc'))).toBe(true);
		expect(isOwnerRequest(request('/export?x=1', 'Bearer abc'))).toBe(true);
		expect(isOwnerRequest(request('/export'))).toBe(false);
		expect(isOwnerRequest(request('/export', 'Basic abc'))).toBe(false);
		expect(isOwnerRequest(request('/export', 'Bearer'))).toBe(false);
		expect(isOwnerRequest(request('/page', 'Bearer abc'))).toBe(false);
		expect(isOwnerRequest(request('/export/', 'Bearer abc'))).toBe(false);
		expect(isOwnerRequest(request('/export/more', 'Bearer abc'))).toBe(false);
	});

	// the same URL parser reads the path here and on the site, so what matches here matches there
	it('reads a tricked path the way the URL parser does and passes only an exact owner path', () => {
		const owner = (path: string) => isOwnerRequest(request(path, 'Bearer abc'));
		expect(owner('/a/../export')).toBe(true);
		expect(owner('/%2e%2e/export')).toBe(true);
		expect(owner('/./export')).toBe(true);
		for (const path of [
			'//export',
			'/export%2F',
			'/export%2f',
			'/%65xport',
			'/Export',
			'/export;x',
			'/export%00',
			'/export%20',
			'/export/.',
			'/export/..',
			'/export/../page',
			'/page/../export/more',
			'/_cfw/../health/x',
			'/health%2Fx'
		]) {
			expect(owner(path), path).toBe(false);
		}
	});

	it('does not read an owner path from the query string or a fragment', () => {
		expect(isOwnerRequest(request('/page?next=/export', 'Bearer abc'))).toBe(false);
		expect(isOwnerRequest(request('/page#/export', 'Bearer abc'))).toBe(false);
	});
});

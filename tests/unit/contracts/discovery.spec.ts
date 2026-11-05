import { describe, expect, it } from 'vitest';
import {
	DISCOVERY_PATH,
	SETTING_PERMISSIONS,
	discoveryDocumentSchema,
	routeSchema,
	xUiSchema
} from '../../../contracts/src/discovery';

const document = {
	v: 1,
	kind: 'drupal',
	version: '1.0.4',
	releaseId: 'rel_1',
	schemaVersion: 3,
	capabilities: [
		{ id: 'spool', state: 'enabled', reason: null },
		{ id: 'cache-api', state: 'disabled', reason: 'CACHE_API=off' }
	],
	settings: {
		schema: {
			type: 'object',
			properties: { WARM_CEILING_MS: { type: 'integer', 'x-ui': {} } }
		},
		values: { WARM_CEILING_MS: 9500 },
		provenance: { WARM_CEILING_MS: 'default' },
		writable: { WARM_CEILING_MS: 'kv' },
		etag: 'abc123'
	},
	routes: [{ id: 'health', method: 'GET', path: '/health', class: 'safe', auth: 'owner-token' }],
	redirects: [{ from: '/_cfw/extend', to: '/sites/{id}/modules' }],
	healthVocabulary: ['ok', 'degraded', 'quarantined'],
	limits: { sites: 1 }
};

describe('discovery', () => {
	it('serves at the well-known path', () => {
		expect(DISCOVERY_PATH).toBe('/.well-known/drupflare');
	});

	it('round-trips a document', () => {
		expect(discoveryDocumentSchema.parse(document)).toEqual(document);
	});

	it('rejects a bad provenance, layer, route class, method and capability state', () => {
		const bad = (patch: Record<string, unknown>) =>
			discoveryDocumentSchema.safeParse({ ...document, ...patch }).success;
		expect(bad({ settings: { ...document.settings, provenance: { a: 'guess' } } })).toBe(false);
		expect(bad({ settings: { ...document.settings, writable: { a: 'default' } } })).toBe(false);
		expect(bad({ routes: [{ ...document.routes[0], class: 'risky' }] })).toBe(false);
		expect(bad({ routes: [{ ...document.routes[0], method: 'TRACE' }] })).toBe(false);
		expect(bad({ capabilities: [{ id: 'x', state: 'maybe', reason: null }] })).toBe(false);
		expect(bad({ settings: { ...document.settings, etag: '' } })).toBe(false);
		expect(bad({ v: 2 })).toBe(false);
	});

	it('accepts an x-ui hint with an unknown widget, because the dashboard falls back to a json editor', () => {
		const hint = {
			group: 'Branding',
			permission: 'appearance',
			widget: 'future-widget',
			danger: false
		};
		expect(xUiSchema.parse(hint)).toEqual(hint);
	});

	it('requires a permission group from the plan on every x-ui hint', () => {
		expect(SETTING_PERMISSIONS).toEqual([
			'runtime',
			'content',
			'security',
			'integrations',
			'appearance',
			'access'
		]);
		expect(xUiSchema.safeParse({ group: 'g' }).success).toBe(false);
		expect(xUiSchema.safeParse({ group: 'g', permission: 'billing' }).success).toBe(false);
		for (const permission of SETTING_PERMISSIONS) {
			expect(xUiSchema.safeParse({ group: 'g', permission }).success).toBe(true);
		}
	});

	it('requires a route path to start with a slash', () => {
		expect(routeSchema.safeParse({ ...document.routes[0], path: 'health' }).success).toBe(
			false
		);
	});
});

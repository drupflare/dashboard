import { describe, expect, it } from 'vitest';
import { newId } from '../../../contracts/src/common';
import { TEMPLATE_MANIFEST_FILE, templateManifestSchema } from '../../../contracts/src/templates';
import { webhookEventSchema } from '../../../contracts/src/webhooks';

describe('templates', () => {
	const manifest = {
		v: 1,
		slug: 'my-template',
		name: 'My Template',
		version: '0.1.0',
		description: 'A custom template.',
		build: { command: 'bun run build', output: '.output' },
		entry: 'server/index.mjs',
		compatibilityDate: '2026-08-01',
		compatibilityFlags: ['nodejs_compat'],
		bindings: [{ type: 'd1', name: 'DB' }],
		secrets: ['SESSION_SECRET'],
		discovery: true
	};

	it('names the manifest file', () => {
		expect(TEMPLATE_MANIFEST_FILE).toBe('drupflare.template.json');
	});

	it('round-trips a manifest', () => {
		expect(templateManifestSchema.parse(manifest)).toEqual(manifest);
		const prebuilt = { ...manifest, build: { command: null, output: 'dist' } };
		expect(templateManifestSchema.parse(prebuilt)).toEqual(prebuilt);
	});

	it('rejects a bad slug, binding name, date, binding type and lowercase secret', () => {
		const bad = (patch: Record<string, unknown>) =>
			templateManifestSchema.safeParse({ ...manifest, ...patch }).success;
		expect(bad({ slug: 'Bad Slug' })).toBe(false);
		expect(bad({ slug: '-lead' })).toBe(false);
		expect(bad({ bindings: [{ type: 'd1', name: 'db' }] })).toBe(false);
		expect(bad({ bindings: [{ type: 'ftp', name: 'DB' }] })).toBe(false);
		expect(bad({ compatibilityDate: 'August' })).toBe(false);
		expect(bad({ secrets: ['secret'] })).toBe(false);
		expect(bad({ discovery: 'yes' })).toBe(false);
		expect(bad({ v: 2 })).toBe(false);
	});
});

describe('webhooks', () => {
	const base = {
		v: 1,
		id: 'evt_00000001',
		createdAt: '2026-11-05T12:00:00Z',
		orgId: newId('org')
	};
	const events = [
		{
			type: 'operation.succeeded',
			data: { opId: newId('op'), operationType: 'site.upgrade', status: 'succeeded' }
		},
		{
			type: 'operation.failed',
			data: {
				opId: newId('op'),
				operationType: 'site.upgrade',
				status: 'failed',
				reason: 'probe failed'
			}
		},
		{
			type: 'site.state.changed',
			data: { siteId: newId('site'), from: 'active', to: 'suspended' }
		},
		{
			type: 'backup.verified',
			data: { siteId: newId('site'), backupId: 'bkp_1', verified: true }
		},
		{ type: 'release.published', data: { releaseId: 'rel_1', version: '1.0.5' } }
	];

	it.each(events)('round-trips $type', (event) => {
		const payload = { ...base, ...event };
		expect(webhookEventSchema.parse(payload)).toEqual(payload);
	});

	it.each(events)('rejects $type with an empty data object', (event) => {
		expect(webhookEventSchema.safeParse({ ...base, type: event.type, data: {} }).success).toBe(
			false
		);
	});

	it('rejects an unknown type, a wrong version and a bad org id', () => {
		expect(
			webhookEventSchema.safeParse({ ...base, type: 'site.exploded', data: {} }).success
		).toBe(false);
		expect(webhookEventSchema.safeParse({ ...base, ...events[4], v: 2 }).success).toBe(false);
		expect(webhookEventSchema.safeParse({ ...base, ...events[4], orgId: 'x' }).success).toBe(
			false
		);
	});
});

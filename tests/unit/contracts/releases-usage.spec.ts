import { describe, expect, it } from 'vitest';
import { newId, sha256Digest } from '../../../contracts/src/common';
import { releaseEventSchema, releaseManifestSchema } from '../../../contracts/src/releases';
import {
	enforcementViews,
	usageAdjustmentSchema,
	usageIntervalSchema,
	usageReportSchema,
	type UsageInterval
} from '../../../contracts/src/usage';

describe('releases', () => {
	it('round-trips a manifest and an event, and rejects a bad kind, digest and url', async () => {
		const digest = await sha256Digest('manifest');
		const manifest = {
			kind: 'worker',
			version: '1.0.5',
			schemaVersion: 4,
			acceptsSchema: 4,
			assets: [{ name: 'worker.js', url: 'https://example.com/worker.js', digest }]
		};
		expect(releaseManifestSchema.parse(manifest)).toEqual(manifest);
		const event = {
			v: 1,
			id: 'evt_00000001',
			type: 'release.published',
			kind: 'worker',
			version: '1.0.5',
			manifestDigest: digest,
			manifestUrl: 'https://example.com/manifest.json',
			schemaVersion: 4,
			acceptsSchema: 4,
			publishedAt: '2026-11-05T12:00:00Z',
			advisoryAt: null
		};
		expect(releaseEventSchema.parse(event)).toEqual(event);
		expect(
			releaseEventSchema.parse({ ...event, type: 'interpreter.published', kind: 'php' }).kind
		).toBe('php');
		expect(releaseEventSchema.safeParse({ ...event, kind: 'plugin' }).success).toBe(false);
		expect(releaseEventSchema.safeParse({ ...event, manifestDigest: 'x' }).success).toBe(false);
		expect(releaseEventSchema.safeParse({ ...event, manifestUrl: 'nope' }).success).toBe(false);
		expect(releaseEventSchema.safeParse({ ...event, type: 'release.deleted' }).success).toBe(
			false
		);
		expect(releaseEventSchema.safeParse({ ...event, schemaVersion: -1 }).success).toBe(false);
		expect(
			releaseEventSchema.parse({ ...event, advisoryAt: '2026-10-21T00:00:00Z' }).advisoryAt
		).toBe('2026-10-21T00:00:00Z');
	});
});

describe('usage', () => {
	const interval: UsageInterval = {
		siteId: newId('site') as UsageInterval['siteId'],
		start: '2026-11-05T12:00:00Z',
		end: '2026-11-05T13:00:00Z',
		accuracy: 'exact',
		views: 100,
		lowerBound: 100,
		observedViews: 96,
		settlement: 'open'
	};

	it('round-trips an interval, a report and an adjustment', () => {
		expect(usageIntervalSchema.parse(interval)).toEqual(interval);
		const report = {
			reportId: 'report_0001',
			source: 'dispatch',
			sentAt: '2026-11-05T13:00:05Z',
			intervals: [interval]
		};
		expect(usageReportSchema.parse(report)).toEqual(report);
		const adjustment = {
			id: 'adjust_0001',
			siteId: interval.siteId,
			intervalStart: interval.start,
			delta: -12,
			reason: 'duplicate flush',
			invoiceRef: null,
			at: '2026-11-06T00:00:00Z'
		};
		expect(usageAdjustmentSchema.parse(adjustment)).toEqual(adjustment);
	});

	it('requires an interval to be one hour long', () => {
		expect(
			usageIntervalSchema.safeParse({ ...interval, end: '2026-11-05T12:30:00Z' }).success
		).toBe(false);
	});

	it('ties the lower bound to the accuracy', () => {
		const parse = (patch: Partial<UsageInterval>) =>
			usageIntervalSchema.safeParse({ ...interval, ...patch }).success;
		expect(parse({ accuracy: 'exact', lowerBound: 99 })).toBe(false);
		expect(parse({ accuracy: 'estimated', lowerBound: 80 })).toBe(true);
		expect(parse({ accuracy: 'estimated', lowerBound: 101 })).toBe(false);
		expect(parse({ accuracy: 'unaccounted', lowerBound: 0 })).toBe(true);
		expect(parse({ accuracy: 'unaccounted', lowerBound: 5 })).toBe(false);
	});

	it('rejects an empty report, an unknown source and a zero adjustment', () => {
		expect(
			usageReportSchema.safeParse({
				reportId: 'report_0001',
				source: 'dispatch',
				sentAt: '2026-11-05T13:00:05Z',
				intervals: []
			}).success
		).toBe(false);
		expect(usageIntervalSchema.safeParse({ ...interval, settlement: 'paid' }).success).toBe(
			false
		);
		expect(
			usageAdjustmentSchema.safeParse({
				id: 'adjust_0001',
				siteId: interval.siteId,
				intervalStart: interval.start,
				delta: 0,
				reason: 'x',
				invoiceRef: null,
				at: interval.end
			}).success
		).toBe(false);
	});

	it('enforces free-tier limits on the lower bound and counts an unaccounted interval as zero', () => {
		expect(enforcementViews(interval)).toBe(100);
		expect(enforcementViews({ ...interval, accuracy: 'estimated', lowerBound: 70 })).toBe(70);
		expect(
			enforcementViews({ ...interval, accuracy: 'unaccounted', lowerBound: 0, views: 40 })
		).toBe(0);
	});
});

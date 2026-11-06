import { describe, expect, it } from 'vitest';
import {
	HOUR_MS,
	UPSTREAM_SITE_THRESHOLD,
	admitRepair,
	autoRepairOn,
	collapseSweeps,
	providerIncidents,
	type Sweep
} from '../../../src/server/domain/incidents';

const bad = (siteId: string, code: string, atMs: number): Sweep => ({
	siteId,
	code,
	atMs,
	bad: true
});
const fine = (siteId: string, code: string, atMs: number): Sweep => ({
	siteId,
	code,
	atMs,
	bad: false
});

describe('collapseSweeps', () => {
	it('collapses twenty bad sweeps into one incident', () => {
		const sweeps = Array.from({ length: 20 }, (_, i) => bad('s1', 'render.empty', i * 60_000));
		const incidents = collapseSweeps(sweeps);
		expect(incidents).toHaveLength(1);
		expect(incidents[0]).toMatchObject({
			siteId: 's1',
			code: 'render.empty',
			count: 20,
			firstAtMs: 0,
			lastAtMs: 19 * 60_000
		});
	});

	it('closes an incident on a clean sweep and opens a new one', () => {
		const incidents = collapseSweeps([
			bad('s1', 'render.empty', 0),
			bad('s1', 'render.empty', 1),
			bad('s1', 'render.empty', 2),
			fine('s1', 'render.empty', 3),
			bad('s1', 'render.empty', 4),
			bad('s1', 'render.empty', 5)
		]);
		expect(incidents.map((i) => i.count)).toEqual([3, 2]);
	});

	it('keeps sites and codes apart', () => {
		const incidents = collapseSweeps([
			bad('s1', 'render.empty', 0),
			bad('s2', 'render.empty', 1),
			bad('s1', 'memory.trend_rising', 2)
		]);
		expect(incidents).toHaveLength(3);
		expect(incidents.every((i) => i.count === 1)).toBe(true);
	});
});

describe('providerIncidents', () => {
	const sites = (n: number) => Array.from({ length: n }, (_, i) => `site-${i}`);

	it('keeps a provider failure at the threshold per site', () => {
		const out = providerIncidents('provider-a', sites(UPSTREAM_SITE_THRESHOLD));
		expect(out).toEqual({
			kind: 'per-site',
			provider: 'provider-a',
			siteIds: sites(UPSTREAM_SITE_THRESHOLD)
		});
	});

	it('collapses an outage above the threshold into one upstream incident', () => {
		const n = UPSTREAM_SITE_THRESHOLD + 1;
		expect(providerIncidents('provider-a', sites(n))).toEqual({
			kind: 'upstream',
			provider: 'provider-a',
			sites: n
		});
	});
});

describe('admitRepair', () => {
	const budget = { perOrgPerHour: 2, fleetPerHour: 3 };
	const now = 10 * HOUR_MS;

	it('refuses a fourth repair for one organisation in the hour', () => {
		const recent = [
			{ orgId: 'a', atMs: now - 1 },
			{ orgId: 'a', atMs: now - 2 }
		];
		expect(admitRepair(recent, { orgId: 'a', nowMs: now }, budget).admit).toBe(false);
		expect(admitRepair(recent, { orgId: 'b', nowMs: now }, budget).admit).toBe(true);
	});

	it('refuses everything past the fleet budget', () => {
		const recent = [
			{ orgId: 'a', atMs: now - 1 },
			{ orgId: 'b', atMs: now - 2 },
			{ orgId: 'c', atMs: now - 3 }
		];
		expect(admitRepair(recent, { orgId: 'd', nowMs: now }, budget).admit).toBe(false);
	});

	it('stops counting repairs older than an hour', () => {
		const recent = [
			{ orgId: 'a', atMs: now - HOUR_MS - 1 },
			{ orgId: 'a', atMs: now - HOUR_MS - 2 }
		];
		expect(admitRepair(recent, { orgId: 'a', nowMs: now }, budget).admit).toBe(true);
	});
});

describe('autoRepairOn', () => {
	it('is off until the global switch is on', () => {
		expect(autoRepairOn({ global: undefined })).toBe(false);
		expect(autoRepairOn({ global: false })).toBe(false);
	});

	it('is off when an organisation or site turns it off', () => {
		expect(autoRepairOn({ global: true, org: false })).toBe(false);
		expect(autoRepairOn({ global: true, site: false })).toBe(false);
	});

	it('is on when every level that is set allows it', () => {
		expect(autoRepairOn({ global: true })).toBe(true);
		expect(autoRepairOn({ global: true, org: true, site: true })).toBe(true);
	});
});

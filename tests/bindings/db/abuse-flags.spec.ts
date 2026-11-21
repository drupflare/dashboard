import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import {
	countOpenAbuse,
	getAbuseReport,
	insertAbuseReport,
	listAbuseReports,
	setAbuseState
} from '../../../src/server/db/repos/abuse';
import {
	isPlatformFlagOn,
	listPlatformFlags,
	setPlatformFlag
} from '../../../src/server/db/repos/platform-flags';
import { type Bindings, type OpenBindings, openBindings, TWO_SHARD_CONFIG } from '../support';

const NOW = 1_700_000_000_000;

describe('abuse reports and platform switches on the directory shard', () => {
	let harness: OpenBindings;
	let env: Bindings;

	beforeAll(async () => {
		harness = await openBindings(TWO_SHARD_CONFIG);
		env = harness.env;
	});

	afterAll(() => harness.close());

	it('stores a report, pages the queue by state and keeps the reviewer', async () => {
		const db = await ensureCollegeDB(env);
		const first = await insertAbuseReport(db, {
			id: 'abuse_a',
			siteId: 'site_a',
			organizationId: 'org_a',
			source: 'report',
			reason: 'phishing',
			now: NOW
		});
		expect(first.state).toBe('open');
		await insertAbuseReport(db, {
			id: 'abuse_b',
			siteId: 'site_b',
			organizationId: 'org_b',
			source: 'automatic',
			reason: 'spam',
			now: NOW + 1
		});

		const moved = await setAbuseState(db, {
			id: 'abuse_a',
			state: 'dismissed',
			reviewer: 'usr_admin',
			notes: 'not a fault',
			now: NOW + 2
		});
		expect(moved).toMatchObject({ state: 'dismissed', reviewer: 'usr_admin' });
		expect(await getAbuseReport(db, 'abuse_missing')).toBeNull();

		const open = await listAbuseReports(db, { state: 'open', limit: 10 });
		expect(open.items.map((report) => report.id)).toEqual(['abuse_b']);
		expect(await countOpenAbuse(db)).toBe(1);
	});

	it('reads a switch nobody set as off and returns the value it was set to', async () => {
		const db = await ensureCollegeDB(env);
		expect(await isPlatformFlagOn(db, 'signups.paused')).toBe(false);
		await setPlatformFlag(db, {
			key: 'signups.paused',
			value: true,
			setBy: 'usr_admin',
			now: NOW
		});
		expect(await isPlatformFlagOn(db, 'signups.paused')).toBe(true);
		const rows = await listPlatformFlags(db);
		expect(rows).toEqual([
			{ key: 'signups.paused', value: true, setBy: 'usr_admin', setAt: NOW }
		]);
	});
});

import { describe, expect, it } from 'vitest';
import {
	canDecide,
	checkExpiry,
	countDecisions,
	decideStanding,
	evidenceCsv,
	holdsRight,
	reviewDue,
	reviewReach,
	staleReport
} from '../../../src/server/domain/access-review';
import { DAY_MS, type ReviewItemView } from '../../../src/shared/access-reviews';
import { SERVICE_ACCOUNT_MAX_MS } from '../../../src/shared/service-accounts';
import { facts, member, ORG, OTHER_ORG, user } from './fixtures';

const NOW = Date.UTC(2026, 10, 21);

const tree = [
	{ id: 'top', parentId: null, kind: 'department' as const },
	{ id: 'child', parentId: 'top', kind: 'department' as const },
	{ id: 'other', parentId: null, kind: 'department' as const }
];
const viewer = (over: Parameters<typeof facts>[0]) => ({
	principal: user,
	facts: facts({ departments: tree, ...over })
});
const adminOf = (targetId: string, orgId = ORG) =>
	({ level: 'department', orgId, targetId, role: 'admin' }) as const;

describe('checkExpiry', () => {
	it('accepts a date up to the maximum and no further', () => {
		expect(checkExpiry(NOW + DAY_MS, NOW)).toBeNull();
		expect(checkExpiry(NOW + SERVICE_ACCOUNT_MAX_MS, NOW)).toBeNull();
		expect(checkExpiry(NOW + SERVICE_ACCOUNT_MAX_MS + 1, NOW)).toBe('too_far');
	});

	it('refuses now, the past and a number that is not a time', () => {
		expect(checkExpiry(NOW, NOW)).toBe('past');
		expect(checkExpiry(NOW - 1, NOW)).toBe('past');
		expect(checkExpiry(Number.NaN, NOW)).toBe('past');
	});
});

describe('canDecide', () => {
	it('refuses the subject and allows anyone else', () => {
		expect(canDecide('u1', 'u1')).toBe(false);
		expect(canDecide('u1', 'u2')).toBe(true);
		expect(canDecide('u1', null)).toBe(true);
	});
});

describe('reviewDue', () => {
	it('is never due when off or when nothing is recorded', () => {
		expect(reviewDue({ interval: 'off', lastOpenedAt: 0 }, NOW)).toBe(false);
		expect(reviewDue({ interval: 'quarterly', lastOpenedAt: null }, NOW)).toBe(false);
	});

	it('counts a quarter as 91 days and a year as 365', () => {
		expect(reviewDue({ interval: 'quarterly', lastOpenedAt: NOW - 90 * DAY_MS }, NOW)).toBe(
			false
		);
		expect(reviewDue({ interval: 'quarterly', lastOpenedAt: NOW - 91 * DAY_MS }, NOW)).toBe(
			true
		);
		expect(reviewDue({ interval: 'yearly', lastOpenedAt: NOW - 364 * DAY_MS }, NOW)).toBe(
			false
		);
		expect(reviewDue({ interval: 'yearly', lastOpenedAt: NOW - 365 * DAY_MS }, NOW)).toBe(true);
	});
});

describe('staleReport', () => {
	const input = (label: string, used: number | null, since: number) => ({
		kind: 'api-key' as const,
		subjectRef: label,
		label,
		lastUsedAt: used,
		since
	});

	it('lists what is at least N days old, oldest first, and counts a never-used one from its start', () => {
		const rows = staleReport(
			[
				input('fresh', NOW - 5 * DAY_MS, NOW - 300 * DAY_MS),
				input('edge', NOW - 90 * DAY_MS, NOW - 300 * DAY_MS),
				input('just under', NOW - 89 * DAY_MS, NOW - 300 * DAY_MS),
				input('never', null, NOW - 200 * DAY_MS)
			],
			NOW
		);
		expect(rows.map((row) => row.label)).toEqual(['never', 'edge']);
		expect(rows[0]).toMatchObject({ days: 200, lastUsedAt: null });
	});

	it('takes the number of days as a parameter', () => {
		expect(staleReport([input('a', NOW - 10 * DAY_MS, 0)], NOW, 7)).toHaveLength(1);
		expect(staleReport([input('a', NOW - 10 * DAY_MS, 0)], NOW, 11)).toHaveLength(0);
	});
});

describe('countDecisions', () => {
	it('tallies each decision', () => {
		expect(
			countDecisions([
				{ decision: 'pending' },
				{ decision: 'keep' },
				{ decision: 'revoke' },
				{ decision: 'revoke' }
			])
		).toEqual({ total: 4, pending: 1, keep: 1, revoke: 2 });
	});
});

describe('evidenceCsv', () => {
	const item = (over: Partial<ReviewItemView>): ReviewItemView => ({
		kind: 'api-key',
		subjectRef: 'k1',
		label: 'ci',
		detail: 'Made by a@b.test',
		heldBy: 'a@b.test',
		decision: 'keep',
		decidedBy: 'c@d.test',
		decidedAt: '2026-11-21T00:00:00.000Z',
		reason: null,
		appliedAt: null,
		applyError: null,
		own: false,
		...over
	});

	it('writes a header and one row a decision', () => {
		const lines = evidenceCsv([item({}), item({ kind: 'member' })])
			.trimEnd()
			.split('\r\n');
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe(
			'Type,Subject,Held By,Detail,Decision,Decided By,Decided At,Reason,Applied At,Not Applied Because'
		);
		expect(lines[2]!.startsWith('member,')).toBe(true);
	});

	it('prefixes every cell that starts like a formula and quotes commas', () => {
		const csv = evidenceCsv([
			item({ label: '=HYPERLINK("x")', reason: '+1,2', heldBy: '@x', detail: '-5' })
		]);
		expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
		expect(csv).toContain(`"'+1,2"`);
		expect(csv).toContain(`'@x`);
		expect(csv).toContain(`'-5`);
	});
});

describe('decideStanding', () => {
	it('lets owners and admins decide anywhere, whatever the setting says', () => {
		for (const role of ['owner', 'admin'] as const) {
			const who = viewer(member(role));
			for (const department of ['top', 'other', null]) {
				for (const on of [true, false]) {
					expect(decideStanding(who, ORG, department, on)).toBe('yes');
				}
			}
		}
	});

	it('lets a department admin decide in their own subtree while the setting is on', () => {
		const who = viewer({ ...member('viewer'), grants: [adminOf('top')] });
		expect(decideStanding(who, ORG, 'top', true)).toBe('yes');
		expect(decideStanding(who, ORG, 'child', true)).toBe('yes');
	});

	it('answers off for a department admin when the setting is off', () => {
		const who = viewer({ ...member('viewer'), grants: [adminOf('top')] });
		expect(decideStanding(who, ORG, 'top', false)).toBe('off');
		expect(decideStanding(who, ORG, 'child', false)).toBe('off');
	});

	it('refuses another branch, the parent of their department and an item with no department', () => {
		const who = viewer({ ...member('viewer'), grants: [adminOf('child')] });
		expect(decideStanding(who, ORG, 'other', true)).toBe('no');
		expect(decideStanding(who, ORG, 'top', true)).toBe('no');
		expect(decideStanding(who, ORG, null, true)).toBe('no');
	});

	it('refuses a viewer, a developer and a department developer', () => {
		const developer = {
			level: 'department',
			orgId: ORG,
			targetId: 'top',
			role: 'developer'
		} as const;
		for (const who of [
			viewer(member('viewer')),
			viewer(member('developer')),
			viewer({ ...member('viewer'), grants: [developer] })
		]) {
			expect(decideStanding(who, ORG, 'top', true)).toBe('no');
		}
	});

	it('ignores a department role in another organization', () => {
		const who = viewer({ ...member('viewer'), grants: [adminOf('top', OTHER_ORG)] });
		expect(decideStanding(who, ORG, 'top', true)).toBe('no');
	});

	it('refuses a suspended person', () => {
		const who = viewer({
			...member('viewer'),
			grants: [adminOf('top')],
			flags: { userSuspended: true }
		});
		expect(decideStanding(who, ORG, 'top', true)).toBe('no');
	});
});

describe('reviewReach and holdsRight', () => {
	it('reaches everything for an owner or admin, a filter for a department admin, nothing otherwise', () => {
		expect(reviewReach(viewer(member('admin')), ORG)).toBe('whole');
		expect(reviewReach(viewer({ ...member('viewer'), grants: [adminOf('top')] }), ORG)).toBe(
			'department'
		);
		expect(reviewReach(viewer(member('viewer')), ORG)).toBe('none');
		expect(reviewReach(viewer(member('developer')), ORG)).toBe('none');
	});

	it('keeps review.manage with owners and admins', () => {
		const department = viewer({ ...member('viewer'), grants: [adminOf('top')] });
		expect(holdsRight(department, ORG, 'review.manage')).toBe(false);
		expect(holdsRight(viewer(member('admin')), ORG, 'review.manage')).toBe(true);
	});
});

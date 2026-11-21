import type { CollegeDBClient } from '@earth-app/collegedb';
import { describe, expect, it } from 'vitest';
import type { Principal } from '../../../../src/server/domain/authorize';
import { moveAbuseReport, openAbuseReport } from '../../../../src/server/services/abuse';
import { principalActor } from '../../../../src/server/services/owner-tokens';

const principal = { kind: 'user', userId: 'usr_1' } as unknown as Principal;

// one known site on one organisation; reports and audit rows held in memory
function fakeDb(sites: Record<string, string> = { site_1: 'org_1' }) {
	const reports = new Map<string, unknown[]>();
	const audit: unknown[][] = [];
	const db = {
		async allAllShards(sql: string, params: unknown[] = []) {
			if (!sql.includes('FROM sites')) return [{ success: true, results: [] }];
			const orgId = sites[String(params[0])];
			return [
				{
					success: true,
					results: orgId === undefined ? [] : [{ organization_id: orgId }]
				}
			];
		},
		async first(_key: string, sql: string, params: unknown[] = []) {
			if (!sql.includes('FROM abuse_reports')) return null;
			const row = reports.get(String(params[0]));
			if (row === undefined) return null;
			const [
				id,
				site_id,
				organization_id,
				source,
				reason,
				state,
				reviewer,
				notes,
				created_at,
				updated_at
			] = row;
			return {
				id,
				site_id,
				organization_id,
				source,
				reason,
				state,
				reviewer,
				notes,
				created_at,
				updated_at
			};
		},
		async run(_key: string, sql: string, params: unknown[]) {
			if (sql.includes('INSERT INTO abuse_reports')) {
				reports.set(String(params[0]), [
					params[0],
					params[1],
					params[2],
					params[3],
					params[4],
					'open',
					null,
					null,
					params[5],
					params[6]
				]);
			}
			if (sql.startsWith('UPDATE abuse_reports')) {
				const [state, reviewer, notes, updated, id] = params;
				const row = reports.get(String(id));
				if (row)
					Object.assign(row, [
						row[0],
						row[1],
						row[2],
						row[3],
						row[4],
						state,
						reviewer,
						notes,
						row[8],
						updated
					]);
			}
			if (sql.includes('INSERT INTO platform_audit')) audit.push(params);
			return {};
		}
	};
	return { db: db as unknown as CollegeDBClient, audit };
}

describe('openAbuseReport', () => {
	it('refuses a report on a site that does not exist', async () => {
		const { db } = fakeDb({});
		await expect(
			openAbuseReport(db, {
				siteId: 'site_9',
				source: 'report',
				reason: 'spam',
				principal,
				now: 1
			})
		).rejects.toMatchObject({ code: 'not_found' });
	});

	it('opens an open report on the site organisation and audits it', async () => {
		const { db, audit } = fakeDb();
		const report = await openAbuseReport(db, {
			siteId: 'site_1',
			source: 'report',
			reason: 'phishing page',
			principal,
			now: 10
		});
		expect(report).toMatchObject({
			siteId: 'site_1',
			organizationId: 'org_1',
			state: 'open',
			source: 'report'
		});
		expect(audit[0]?.[1]).toBe('admin.abuse.open');
		expect(audit[0]?.[0]).toBe(principalActor(principal));
	});
});

describe('moveAbuseReport', () => {
	it('moves a report through the states and records the reviewer', async () => {
		const { db, audit } = fakeDb();
		const opened = await openAbuseReport(db, {
			siteId: 'site_1',
			source: 'report',
			reason: 'spam',
			principal,
			now: 10
		});
		const moved = await moveAbuseReport(db, {
			id: opened.id,
			state: 'reviewing',
			notes: 'checking',
			principal,
			now: 20
		});
		expect(moved).toMatchObject({
			state: 'reviewing',
			reviewer: principalActor(principal),
			notes: 'checking'
		});
		expect(audit.at(-1)?.[1]).toBe('admin.abuse.move');
	});

	it('refuses to reopen an actioned report', async () => {
		const { db } = fakeDb();
		const opened = await openAbuseReport(db, {
			siteId: 'site_1',
			source: 'report',
			reason: 'spam',
			principal,
			now: 10
		});
		await moveAbuseReport(db, {
			id: opened.id,
			state: 'actioned',
			notes: null,
			principal,
			now: 11
		});
		await expect(
			moveAbuseReport(db, { id: opened.id, state: 'open', notes: null, principal, now: 12 })
		).rejects.toMatchObject({ code: 'conflict', details: { reason: 'invalid_transition' } });
	});
});

import type { CollegeDBClient } from '@earth-app/collegedb';
import type { SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { getAbuseReport, insertAbuseReport } from '../../../../src/server/db/repos/abuse';
import { listPlatformAudit } from '../../../../src/server/db/repos/platform-audit';
import {
	setSiteSuspension,
	suspendFromReport
} from '../../../../src/server/services/site-suspension';
import type { SupportServices } from '../../../../src/server/services/support';
import { addReadySite, sqliteClient } from '../fixtures/sqlite-client';

const ADMIN = { kind: 'user', userId: 'usr_admin' } as const;
const ORG = 'org_1';
const SITE = 'site_aaaaaaaaaaaaaaaaaaaaaaaaaa';

interface Statement {
	key: string;
	sql: string;
	bindings?: SQLInputValue[];
}

function world(options: { siteState?: string; accountId?: string | null } = {}) {
	const { raw, client } = sqliteClient();
	// the operation store writes through a batch and the site lookup fans out over shards
	Object.assign(client, {
		async batch(statements: Statement[]) {
			return statements.map((s) => {
				const result = raw.prepare(s.sql).run(...(s.bindings ?? []));
				return { success: true, results: [], meta: { changes: Number(result.changes) } };
			});
		},
		async allAllShards(sql: string, params: SQLInputValue[] = []) {
			return [{ success: true, results: raw.prepare(sql).all(...params) }];
		}
	});
	addReadySite(raw, ORG, SITE);
	raw.prepare('UPDATE sites SET account_id = ?, state = ? WHERE id = ?').run(
		options.accountId === undefined ? 'acct_1' : options.accountId,
		options.siteState ?? 'active',
		SITE
	);
	let n = 0;
	const started: { workflow: string; id: string; params: Record<string, unknown> }[] = [];
	const audits: { orgId: string; action: string }[] = [];
	const mails: string[] = [];
	const reviews: string[] = [];
	let failStart = false;
	const services: SupportServices = {
		getDb: async () => client as CollegeDBClient,
		audit: async (orgId, input) => void audits.push({ orgId, action: input.action }),
		ownerEmails: async () => ['a@example.test', 'b@example.test'],
		notify: async (to, summary, reviewPath) => {
			mails.push(`${to}: ${summary}`);
			reviews.push(reviewPath);
		},
		startOperation: async (request) => {
			if (failStart) throw new Error('engine down');
			started.push(request as never);
		},
		newId: () => `x_${++n}`,
		now: () => 1_800_000_000_000
	};
	return {
		raw,
		client: client as CollegeDBClient,
		services,
		started,
		audits,
		mails,
		reviews,
		failStart: () => void (failStart = true)
	};
}

const report = (w: ReturnType<typeof world>, id = 'abuse_1') =>
	insertAbuseReport(w.client, {
		id,
		siteId: SITE,
		organizationId: ORG,
		source: 'report',
		reason: 'phishing page',
		now: 1
	});

describe('suspending a site from an abuse report', () => {
	it('starts one operation, audits both places, closes the report and tells the owners', async () => {
		const w = world();
		await report(w);
		const result = await suspendFromReport(w.services, {
			reportId: 'abuse_1',
			principal: ADMIN
		});

		expect(w.started).toHaveLength(1);
		expect(w.started[0]).toMatchObject({
			workflow: 'site-auth-state',
			params: { siteId: SITE, orgId: ORG, state: 'suspended', reason: 'abuse' }
		});
		expect(result.operation.operation).toMatchObject({ type: 'config.apply' });
		expect(result.report.state).toBe('actioned');
		expect(w.audits).toEqual([{ orgId: ORG, action: 'site.suspend' }]);
		const platform = (await listPlatformAudit(w.client)).map((row) => row.action);
		expect(platform).toEqual(['admin.abuse.move', 'admin.site.suspend']);
		expect(result.notified).toBe(2);
		expect(w.mails[0]).toContain('suspended');
		expect(w.reviews).toEqual([`/sites/${SITE}`, `/sites/${SITE}`]);
	});

	it('answers a repeat with the same operation, starting and mailing nothing more', async () => {
		const w = world();
		await report(w);
		const first = await suspendFromReport(w.services, {
			reportId: 'abuse_1',
			principal: ADMIN
		});
		const again = await suspendFromReport(w.services, {
			reportId: 'abuse_1',
			principal: ADMIN
		});
		expect(again.operation.operation.id).toBe(first.operation.operation.id);
		expect(again.notified).toBe(0);
		expect(w.started).toHaveLength(1);
		expect(w.mails).toHaveLength(2);
	});

	it('refuses a dismissed report and an unknown one', async () => {
		const w = world();
		await report(w);
		w.raw.prepare("UPDATE abuse_reports SET state = 'dismissed'").run();
		await expect(
			suspendFromReport(w.services, { reportId: 'abuse_1', principal: ADMIN })
		).rejects.toMatchObject({ details: { reason: 'invalid_transition' } });
		await expect(
			suspendFromReport(w.services, { reportId: 'abuse_none', principal: ADMIN })
		).rejects.toMatchObject({ code: 'not_found' });
		expect(w.started).toEqual([]);
	});

	it('closes the operation as failed and mails nobody when the engine refuses the start', async () => {
		const w = world();
		await report(w);
		w.failStart();
		await expect(
			suspendFromReport(w.services, { reportId: 'abuse_1', principal: ADMIN })
		).rejects.toBeDefined();
		expect(w.mails).toEqual([]);
		const op = w.raw.prepare('SELECT status FROM operations').get();
		expect(op).toMatchObject({ status: 'failed' });
		expect((await getAbuseReport(w.client, 'abuse_1'))?.state).toBe('open');
	});
});

describe('lifting a suspension', () => {
	it('starts the same workflow with state active and tells the owners', async () => {
		const w = world({ siteState: 'suspended' });
		const result = await setSiteSuspension(w.services, {
			siteId: SITE,
			state: 'active',
			reason: 'lift',
			principal: ADMIN,
			key: 'req-1'
		});
		expect(w.started[0]).toMatchObject({
			workflow: 'site-auth-state',
			params: { state: 'active' }
		});
		expect(w.audits).toEqual([{ orgId: ORG, action: 'site.unsuspend' }]);
		expect((await listPlatformAudit(w.client))[0]?.action).toBe('admin.site.unsuspend');
		expect(result.notified).toBe(2);
	});

	it('refuses a live site with no account and starts nothing', async () => {
		const w = world({ accountId: null });
		await expect(
			setSiteSuspension(w.services, {
				siteId: SITE,
				state: 'active',
				reason: 'lift',
				principal: ADMIN,
				key: 'k'
			})
		).rejects.toMatchObject({ details: { reason: 'site_not_live' } });
		expect(w.started).toEqual([]);
	});

	it('refuses a site that is gone or unknown', async () => {
		const gone = world({ siteState: 'tombstoned' });
		await expect(
			setSiteSuspension(gone.services, {
				siteId: SITE,
				state: 'active',
				reason: 'lift',
				principal: ADMIN,
				key: 'k'
			})
		).rejects.toMatchObject({ details: { reason: 'site_not_live' } });
		await expect(
			setSiteSuspension(gone.services, {
				siteId: 'site_unknown',
				state: 'active',
				reason: 'lift',
				principal: ADMIN,
				key: 'k'
			})
		).rejects.toMatchObject({ code: 'not_found' });
	});
});

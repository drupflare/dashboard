import type { CollegeDBClient } from '@earth-app/collegedb';
import { describe, expect, it } from 'vitest';
import { isPlatformFlagOn } from '../../../../src/server/db/repos/platform-flags';
import type { Principal } from '../../../../src/server/domain/authorize';
import { listFlags, setFlag } from '../../../../src/server/services/flags';
import { setLadderServices } from '../../../../src/server/services/ladder';
import { principalActor } from '../../../../src/server/services/owner-tokens';

const principal = { kind: 'user', userId: 'usr_1' } as unknown as Principal;

// the platform_flags rows and the audit rows, held in memory; the ladder has no row
function fakeDb() {
	const flags = new Map<string, { value: string; set_by: string; set_at: number }>();
	const audit: unknown[][] = [];
	const db = {
		async all(_key: string, sql: string) {
			if (!sql.includes('platform_flags')) return { results: [] };
			return {
				results: [...flags].map(([key, row]) => ({ key, ...row }))
			};
		},
		async first(_key: string, sql: string, params: unknown[] = []) {
			if (sql.includes('platform_flags')) {
				const row = flags.get(String(params[0]));
				return row ? { value: row.value } : null;
			}
			return null;
		},
		async run(_key: string, sql: string, params: unknown[]) {
			if (sql.includes('INSERT INTO platform_flags')) {
				flags.set(String(params[0]), {
					value: String(params[1]),
					set_by: String(params[2]),
					set_at: Number(params[3])
				});
			}
			if (sql.includes('INSERT INTO platform_audit')) audit.push(params);
			return {};
		}
	};
	return { db: db as unknown as CollegeDBClient, audit };
}

describe('listFlags', () => {
	it('lists every switch and reads one nobody has set as off', async () => {
		const { db } = fakeDb();
		const flags = await listFlags(db);
		expect(flags.map((flag) => flag.key)).toEqual([
			'signups.paused',
			'notifications.paused',
			'promotion.stopped',
			'ladder.auto'
		]);
		expect(flags.every((flag) => flag.value === false && flag.setAt === null)).toBe(true);
	});
});

describe('setFlag', () => {
	it('sets a platform switch, audits who set it and when', async () => {
		const { db, audit } = fakeDb();
		const view = await setFlag(db, {
			key: 'signups.paused',
			value: true,
			principal,
			now: 5_000
		});
		expect(view).toEqual({
			key: 'signups.paused',
			value: true,
			setBy: principalActor(principal),
			setAt: 5_000
		});
		expect(await isPlatformFlagOn(db, 'signups.paused')).toBe(true);
		expect(audit).toHaveLength(1);
		expect(audit[0]?.[1]).toBe('admin.flags.set');
		expect(audit[0]?.[2]).toBe('signups.paused');
	});

	it('refuses to change automatic repair without the confirmation word', async () => {
		const { db } = fakeDb();
		setLadderServices({ getDb: async () => db, audit: async () => undefined, now: () => 1 });
		try {
			await expect(
				setFlag(db, { key: 'ladder.auto', value: true, principal, now: 1 })
			).rejects.toMatchObject({ code: 'unprocessable' });
		} finally {
			setLadderServices(null);
		}
	});
});

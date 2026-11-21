import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import {
	createProcurement,
	listProcurementViews,
	procurementCsv,
	updateProcurementRecord,
	type ProcurementServices
} from '../../../src/server/services/procurement';
import { procurementBodySchema, type ProcurementBody } from '../../../src/shared/procurement';
import { openBindings, type Bindings, type OpenBindings } from '../support';

let open: OpenBindings;
let db: CollegeDBClient;

beforeAll(async () => {
	open = await openBindings();
	db = await ensureCollegeDB(open.env as Bindings);
});

afterAll(() => open.close());

function deps(): ProcurementServices {
	let clock = Date.UTC(2026, 10, 21);
	return { getDb: async () => db, newId: () => crypto.randomUUID(), now: () => ++clock };
}

const orgId = () => `org_${crypto.randomUUID()}`;

const record = (overrides: Partial<ProcurementBody> = {}): ProcurementBody => ({
	kind: 'po',
	reference: 'PO-1001',
	signatory: 'Pat Example',
	amount: '$12,400.00 (estimate)',
	issuedOn: '2026-11-02',
	dueOn: '2026-12-02',
	notes: 'Renewal, year two',
	...overrides
});

describe('procurement records', () => {
	it('keeps the amount exactly as typed', async () => {
		const org = orgId();
		const view = await createProcurement(deps(), org, record({ amount: 'TBD, see quote' }));
		expect(view.amount).toBe('TBD, see quote');
	});

	it('lists and edits only the records of the organisation asked for', async () => {
		const mine = orgId();
		const theirs = orgId();
		const d = deps();
		const created = await createProcurement(d, mine, record({ reference: 'Q-7' }));
		await createProcurement(d, theirs, record({ reference: 'Q-8' }));

		expect((await listProcurementViews(d, mine)).map((r) => r.reference)).toEqual(['Q-7']);
		expect(await listProcurementViews(d, theirs)).toHaveLength(1);

		await expect(
			updateProcurementRecord(d, theirs, created.id, record({ reference: 'changed' }))
		).rejects.toMatchObject({ code: 'not_found' });
	});

	it('exports CSV with formula-looking cells neutralised', async () => {
		const org = orgId();
		const d = deps();
		await createProcurement(
			d,
			org,
			record({ reference: '=HYPERLINK("https://x.test")', notes: '+1 line' })
		);
		const csv = await procurementCsv(d, org);
		expect(csv.split('\r\n')[0]).toBe(
			'Kind,Reference,Signatory,Amount,Issued On,Due On,Notes,Recorded At'
		);
		expect(csv).toContain(`"'=HYPERLINK(""https://x.test"")"`);
		expect(csv).toContain("'+1 line");
	});

	it('accepts the four kinds and rejects anything else', () => {
		for (const kind of ['quote', 'po', 'invoice', 'contract']) {
			expect(procurementBodySchema.safeParse({ kind, reference: 'R' }).success).toBe(true);
		}
		expect(procurementBodySchema.safeParse({ kind: 'receipt', reference: 'R' }).success).toBe(
			false
		);
	});
});

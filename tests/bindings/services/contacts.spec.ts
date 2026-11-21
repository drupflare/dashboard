import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { renderMail } from '../../../src/server/emails';
import {
	confirmContact,
	requestVerification,
	saveContact,
	sendTest,
	type ContactMail,
	type ContactServices
} from '../../../src/server/services/contacts';
import { CONTACT_VERIFY_TTL_MS, type ContactBody } from '../../../src/shared/contacts';
import { openBindings, type Bindings, type OpenBindings } from '../support';

let open: OpenBindings;
let db: CollegeDBClient;

beforeAll(async () => {
	open = await openBindings();
	db = await ensureCollegeDB(open.env as Bindings);
});

afterAll(() => open.close());

interface Sent {
	to: string;
	kind: string;
	category?: string;
	confirmUrl?: string;
}

function harness(options: { failMail?: boolean } = {}) {
	let clock = Date.UTC(2026, 10, 21);
	const sent: Sent[] = [];
	const mail: ContactMail = {
		async send(to, input) {
			if (options.failMail) throw new Error('mail is down');
			sent.push({
				to,
				kind: input.kind,
				category: renderMail(input).category,
				confirmUrl: input.kind === 'contact-verify' ? input.confirmUrl : undefined
			});
		}
	};
	const deps: ContactServices = {
		getDb: async () => db,
		mail,
		baseUrl: 'https://app.example.test',
		now: () => clock
	};
	return {
		deps,
		sent,
		advance(ms: number) {
			clock += ms;
		}
	};
}

const orgId = () => `org_${crypto.randomUUID()}`;
const body = (email: string, notifyOn = false): ContactBody => ({
	name: 'Pat Example',
	email,
	notifyOn
});
const tokenFrom = (sent: Sent) => new URL(sent.confirmUrl ?? '').searchParams.get('token') ?? '';

describe('contact verification', () => {
	it('marks a contact verified once the emailed link is confirmed', async () => {
		const h = harness();
		const org = orgId();
		await saveContact(h.deps, org, 'technical', body('pat@example.test'));
		await requestVerification(h.deps, org, 'technical');
		await confirmContact(h.deps, tokenFrom(h.sent[0]));
		const [view] = (await listRows(org)).filter((row) => row.role === 'technical');
		expect(view.verified_at).not.toBeNull();
	});

	it('spends the link on the first confirm', async () => {
		const h = harness();
		const org = orgId();
		await saveContact(h.deps, org, 'billing', body('bill@example.test'));
		await requestVerification(h.deps, org, 'billing');
		const token = tokenFrom(h.sent[0]);
		await confirmContact(h.deps, token);
		await expect(confirmContact(h.deps, token)).rejects.toMatchObject({ code: 'validation' });
	});

	it('refuses a link after seven days', async () => {
		const h = harness();
		const org = orgId();
		await saveContact(h.deps, org, 'legal', body('legal@example.test'));
		await requestVerification(h.deps, org, 'legal');
		h.advance(CONTACT_VERIFY_TTL_MS + 1);
		await expect(confirmContact(h.deps, tokenFrom(h.sent[0]))).rejects.toMatchObject({
			code: 'validation'
		});
	});

	it('does not let a token from one organisation verify the same role in another', async () => {
		const h = harness();
		const orgA = orgId();
		const orgB = orgId();
		await saveContact(h.deps, orgA, 'technical', body('shared@example.test'));
		await saveContact(h.deps, orgB, 'technical', body('shared@example.test'));
		await requestVerification(h.deps, orgA, 'technical');
		await confirmContact(h.deps, tokenFrom(h.sent[0]));
		const rowsB = (await listRows(orgB)).filter((row) => row.role === 'technical');
		expect(rowsB[0].verified_at).toBeNull();
	});

	it('refuses a link sent to an address that has since changed', async () => {
		const h = harness();
		const org = orgId();
		await saveContact(h.deps, org, 'technical', body('old@example.test'));
		await requestVerification(h.deps, org, 'technical');
		await saveContact(h.deps, org, 'technical', body('new@example.test'));
		await expect(confirmContact(h.deps, tokenFrom(h.sent[0]))).rejects.toMatchObject({
			code: 'validation'
		});
	});

	it('keeps the verified state when only the name changes, and clears it on a new address', async () => {
		const h = harness();
		const org = orgId();
		await saveContact(h.deps, org, 'technical', body('keep@example.test'));
		await requestVerification(h.deps, org, 'technical');
		await confirmContact(h.deps, tokenFrom(h.sent[0]));
		const renamed = await saveContact(h.deps, org, 'technical', {
			...body('keep@example.test'),
			name: 'New Name'
		});
		expect(renamed.verifiedAt).not.toBeNull();
		const moved = await saveContact(h.deps, org, 'technical', body('moved@example.test'));
		expect(moved.verifiedAt).toBeNull();
	});

	it('reports a failed mail send in the error, not as a success', async () => {
		const h = harness({ failMail: true });
		const org = orgId();
		await saveContact(h.deps, org, 'technical', body('down@example.test'));
		await expect(requestVerification(h.deps, org, 'technical')).rejects.toMatchObject({
			code: 'unprocessable'
		});
	});
});

describe('test notification', () => {
	it('refuses an unverified contact', async () => {
		const h = harness();
		const org = orgId();
		await saveContact(h.deps, org, 'technical', body('new@example.test', true));
		await expect(sendTest(h.deps, org, 'technical')).rejects.toMatchObject({
			code: 'precondition_failed'
		});
	});

	it('sends nothing to a verified contact that is off, and says so', async () => {
		const h = harness();
		const org = orgId();
		await saveContact(h.deps, org, 'technical', body('off@example.test', false));
		await requestVerification(h.deps, org, 'technical');
		await confirmContact(h.deps, tokenFrom(h.sent[0]));
		h.sent.length = 0;
		const result = await sendTest(h.deps, org, 'technical');
		expect(result.sent).toBe(false);
		expect(h.sent).toHaveLength(0);
	});

	it('sends one operational test to a verified contact that is on', async () => {
		const h = harness();
		const org = orgId();
		await saveContact(h.deps, org, 'technical', body('on@example.test', true));
		await requestVerification(h.deps, org, 'technical');
		await confirmContact(h.deps, tokenFrom(h.sent[0]));
		h.sent.length = 0;
		const result = await sendTest(h.deps, org, 'technical');
		expect(result.sent).toBe(true);
		expect(h.sent).toEqual([
			expect.objectContaining({ to: 'on@example.test', kind: 'test-notice', category: 'ops' })
		]);
	});
});

async function listRows(org: string): Promise<{ role: string; verified_at: number | null }[]> {
	const { results } = await db.all<{ role: string; verified_at: number | null }>(
		org,
		'SELECT role, verified_at FROM org_contacts WHERE organization_id = ?',
		[org]
	);
	return results;
}

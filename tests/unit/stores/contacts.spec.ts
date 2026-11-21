import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContactBody, ContactView, TestResult } from '~/shared/contacts';
import { useContactsStore } from '~/stores/contacts';
import { calls, clearBrowserState, registerApi } from './store-support';

const ORG = 'org_campus';
const base = `/api/v1/orgs/${ORG}/contacts`;

const billing: ContactView = {
	role: 'billing',
	name: 'Pat Lee',
	email: 'pat@example.org',
	verifiedAt: null,
	notifyOn: true,
	updatedAt: '2026-11-01T00:00:00.000Z'
};

const body: ContactBody = { name: 'Pat Lee', email: 'pat@example.org', notifyOn: true };

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useContactsStore().$reset();
});

afterEach(() => {
	cleanup();
});

const count = (method: string, path: string) =>
	calls.filter((call) => call.method === method && call.path === path).length;

describe('contacts store', () => {
	it('loads the contacts of one organisation once and reads them again only when forced', async () => {
		cleanup = registerApi({ [`GET ${base}`]: { body: { items: [billing] } } });
		const store = useContactsStore();
		await store.load(ORG);
		await store.load(ORG);
		expect(count('GET', base)).toBe(1);
		expect(store.contacts.get(ORG)).toEqual([billing]);
		await store.load(ORG, true);
		expect(count('GET', base)).toBe(2);
	});

	it('saves a role other than recovery on its own path, then reads the list again', async () => {
		cleanup = registerApi({
			[`PUT ${base}/billing`]: { body: billing },
			[`GET ${base}`]: { body: { items: [billing] } }
		});
		expect(await useContactsStore().save(ORG, 'billing', body)).toBe(true);
		expect(count('PUT', `${base}/billing`)).toBe(1);
		expect(count('GET', base)).toBe(1);
	});

	it('saves the recovery contact on the recovery route, which needs step-up', async () => {
		cleanup = registerApi({
			[`PUT ${base}/recovery`]: { body: { ...billing, role: 'recovery' } },
			[`GET ${base}`]: { body: { items: [] } }
		});
		expect(await useContactsStore().save(ORG, 'recovery', body)).toBe(true);
		expect(count('PUT', `${base}/recovery`)).toBe(1);
		expect(count('PUT', `${base}/billing`)).toBe(0);
	});

	it('keeps a refused save and does not read the list again', async () => {
		cleanup = registerApi({
			[`PUT ${base}/billing`]: {
				status: 403,
				body: {
					code: 'forbidden',
					message: 'You cannot change this',
					details: {},
					requestId: 'req_1'
				}
			}
		});
		const store = useContactsStore();
		expect(await store.save(ORG, 'billing', body)).toBe(false);
		expect(store.saveError?.message).toBe('You cannot change this');
		expect(count('GET', base)).toBe(0);
	});

	it('sends a confirmation to a contact', async () => {
		cleanup = registerApi({
			[`POST ${base}/billing/verify`]: { body: billing }
		});
		const store = useContactsStore();
		expect(await store.verify(ORG, 'billing')).toBe(true);
		expect(count('POST', `${base}/billing/verify`)).toBe(1);
	});

	it('returns the answer of a test notice, and null when the test is refused', async () => {
		const answer: TestResult = {
			sent: true,
			message: 'The test was sent to the verified contact.'
		};
		cleanup = registerApi({
			[`POST ${base}/billing/test`]: { body: answer },
			[`POST ${base}/legal/test`]: {
				status: 412,
				body: {
					code: 'precondition_failed',
					message: 'Verify this contact before you send a test',
					details: {},
					requestId: 'req_2'
				}
			}
		});
		const store = useContactsStore();
		expect(await store.test(ORG, 'billing')).toEqual(answer);
		expect(await store.test(ORG, 'legal')).toBeNull();
		expect(store.saveError?.message).toBe('Verify this contact before you send a test');
	});

	it('confirms a token from the mail link on the public route', async () => {
		cleanup = registerApi({ 'POST /api/v1/contacts/confirm': { body: { verified: true } } });
		const token = 'a'.repeat(40);
		expect(await useContactsStore().confirm(token)).toBe(true);
		expect(calls.find((call) => call.path === '/api/v1/contacts/confirm')?.body).toEqual({
			token
		});
	});
});

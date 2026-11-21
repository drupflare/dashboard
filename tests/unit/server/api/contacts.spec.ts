import type { CollegeDBClient } from '@earth-app/collegedb';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import contactConfirm from '../../../../src/server/api/v1/contacts/confirm.post';
import contactSet from '../../../../src/server/api/v1/orgs/[orgId]/contacts/[role].put';
import contactTest from '../../../../src/server/api/v1/orgs/[orgId]/contacts/[role]/test.post';
import contactVerify from '../../../../src/server/api/v1/orgs/[orgId]/contacts/[role]/verify.post';
import contactList from '../../../../src/server/api/v1/orgs/[orgId]/contacts/index.get';
import recoverySet from '../../../../src/server/api/v1/orgs/[orgId]/contacts/recovery.put';
import { SCHEMA_STATEMENTS } from '../../../../src/server/db/schema';
import { setContactServices, type ContactServices } from '../../../../src/server/services/contacts';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { facts, fresh, member, ORG, OTHER_ORG } from '../../domain/fixtures';
import { asKey, asUser, send, setup } from '../fixtures/harness';

const NOW = 1_800_000_000_000;
const CONTACT = { name: 'Pat Lee', email: 'pat@example.org', notifyOn: true };

interface Sent {
	to: string;
	input: Record<string, unknown>;
}

function world() {
	const sql = new DatabaseSync(':memory:');
	for (const statement of SCHEMA_STATEMENTS) sql.exec(statement);
	const db = {
		async first(_key: string, text: string, bindings: unknown[] = []) {
			return sql.prepare(text).get(...(bindings as never[])) ?? null;
		},
		async all(_key: string, text: string, bindings: unknown[] = []) {
			return { results: sql.prepare(text).all(...(bindings as never[])) };
		},
		async run(_key: string, text: string, bindings: unknown[] = []) {
			const result = sql.prepare(text).run(...(bindings as never[]));
			return { meta: { changes: Number(result.changes) } };
		}
	} as unknown as CollegeDBClient;
	for (const id of [ORG, OTHER_ORG]) {
		sql.prepare(
			'INSERT INTO organizations (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, 1, 1)'
		).run(id, `Org ${id}`, 'seed');
	}
	const mail = { sent: [] as Sent[], down: false };
	const services: ContactServices = {
		getDb: async () => db,
		mail: {
			async send(to, input) {
				if (mail.down) throw new Error('mail service down');
				mail.sent.push({ to, input: input as Record<string, unknown> });
			}
		},
		baseUrl: 'https://app.example.test',
		now: () => NOW
	};
	setContactServices(services);
	return { sql, mail };
}

// the token is only in the mail; the page would read it from the link
function tokenSent(mail: { sent: Sent[] }): string {
	const link = mail.sent.at(-1)?.input.confirmUrl as string;
	return new URL(link).searchParams.get('token') ?? '';
}

const asMember = (role: 'owner' | 'admin' | 'billing' | 'viewer') =>
	setup({ facts: () => facts({ ...member(role), ...fresh }) });

const asOtherOwner = () =>
	setup({
		facts: () => facts({ membership: { orgId: OTHER_ORG, role: 'owner' }, ...fresh })
	});

const setContact = (role: string, body: unknown = CONTACT, orgId = ORG) =>
	send(contactSet, '/api/v1/orgs/:orgId/contacts/:role', {
		method: 'PUT',
		path: `/api/v1/orgs/${orgId}/contacts/${role}`,
		headers: asUser,
		json: body
	});

const listContacts = (orgId = ORG) =>
	send(contactList, '/api/v1/orgs/:orgId/contacts', {
		path: `/api/v1/orgs/${orgId}/contacts`,
		headers: asUser
	});

const requestVerify = (role = 'technical', orgId = ORG) =>
	send(contactVerify, '/api/v1/orgs/:orgId/contacts/:role/verify', {
		method: 'POST',
		path: `/api/v1/orgs/${orgId}/contacts/${role}/verify`,
		headers: asUser,
		json: {}
	});

const runTest = (role = 'technical', orgId = ORG) =>
	send(contactTest, '/api/v1/orgs/:orgId/contacts/:role/test', {
		method: 'POST',
		path: `/api/v1/orgs/${orgId}/contacts/${role}/test`,
		headers: asUser,
		json: {}
	});

const confirm = (token: string) =>
	send(contactConfirm, '/api/v1/contacts/confirm', {
		method: 'POST',
		path: '/api/v1/contacts/confirm',
		json: { token }
	});

const setRecovery = (body: unknown = CONTACT, orgId = ORG) =>
	send(recoverySet, '/api/v1/orgs/:orgId/contacts/recovery', {
		method: 'PUT',
		path: `/api/v1/orgs/${orgId}/contacts/recovery`,
		headers: asUser,
		json: body
	});

afterEach(() => {
	setContactServices(null);
	resetApiDeps();
});

beforeEach(() => {
	resetApiDeps();
	world();
});

describe('setting a contact', () => {
	it('sets a contact unverified, and lists it', async () => {
		asMember('owner');
		const reply = await setContact('technical');
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({
			role: 'technical',
			email: CONTACT.email,
			verifiedAt: null
		});
		expect(((await listContacts()).json as { items: unknown[] }).items).toHaveLength(1);
	});

	it('lets an admin set a contact and refuses billing', async () => {
		asMember('admin');
		expect((await setContact('legal')).status).toBe(200);
		asMember('billing');
		expect((await setContact('legal')).status).toBe(403);
	});

	it('refuses the recovery role on the generic route, so its step-up cannot be skipped', async () => {
		const w = world();
		asMember('owner');
		const reply = await setContact('recovery');
		expect(reply.status).toBe(400);
		expect(w.sql.prepare('SELECT role FROM org_contacts').all()).toEqual([]);
	});

	it('keeps the verified state when the same address is saved again, and clears it on a new address', async () => {
		const w = world();
		asMember('owner');
		await setContact('technical');
		await requestVerify();
		await confirm(tokenSent(w.mail));

		const same = await setContact('technical', { ...CONTACT, name: 'Pat Q. Lee' });
		expect(same.json).toMatchObject({ verifiedAt: expect.any(String) });

		const changed = await setContact('technical', { ...CONTACT, email: 'new@example.org' });
		expect(changed.json).toMatchObject({ verifiedAt: null });
	});
});

describe('the recovery contact', () => {
	it('refuses an admin, and an owner without a fresh sign-in', async () => {
		asMember('admin');
		expect((await setRecovery()).status).toBe(403);

		setup({ facts: () => facts({ ...member('owner') }) });
		expect((await setRecovery()).status).toBe(403);
	});

	it('lets an owner with a fresh sign-in set it', async () => {
		asMember('owner');
		const reply = await setRecovery();
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({ role: 'recovery', verifiedAt: null });
	});

	it('refuses an API key on the recovery route', async () => {
		asMember('owner');
		const reply = await send(recoverySet, '/api/v1/orgs/:orgId/contacts/recovery', {
			method: 'PUT',
			path: `/api/v1/orgs/${ORG}/contacts/recovery`,
			headers: asKey,
			json: CONTACT
		});
		expect(reply.status).toBe(403);
	});
});

describe('verifying a contact', () => {
	it('sends a one-time link, and confirming it verifies the address', async () => {
		const w = world();
		asMember('owner');
		await setContact('technical');
		const sent = await requestVerify();
		expect(sent.status).toBe(200);
		expect(w.mail.sent).toHaveLength(1);
		expect(w.mail.sent[0]).toMatchObject({
			to: CONTACT.email,
			input: { kind: 'contact-verify' }
		});

		const done = await confirm(tokenSent(w.mail));
		expect(done.json).toEqual({ verified: true });
		const listed = (await listContacts()).json as { items: { verifiedAt: string | null }[] };
		expect(listed.items[0]?.verifiedAt).toEqual(expect.any(String));
	});

	it('works once: a second use of the same link is refused', async () => {
		const w = world();
		asMember('owner');
		await setContact('technical');
		await requestVerify();
		const token = tokenSent(w.mail);
		expect((await confirm(token)).status).toBe(200);
		expect((await confirm(token)).status).toBe(400);
	});

	it('stops a link from working once the address changes', async () => {
		const w = world();
		asMember('owner');
		await setContact('technical');
		await requestVerify();
		const token = tokenSent(w.mail);
		await setContact('technical', { ...CONTACT, email: 'new@example.org' });

		expect((await confirm(token)).status).toBe(400);
		const listed = (await listContacts()).json as { items: { verifiedAt: string | null }[] };
		expect(listed.items[0]?.verifiedAt).toBeNull();
	});

	it('refuses a token nobody was sent', async () => {
		world();
		expect((await confirm('x'.repeat(40))).status).toBe(400);
	});

	it('says so when the mail service does not accept the message', async () => {
		const w = world();
		asMember('owner');
		await setContact('technical');
		w.mail.down = true;
		expect((await requestVerify()).status).toBe(422);
	});
});

describe('the test notice', () => {
	it('refuses a test to a contact that is not verified', async () => {
		asMember('owner');
		await setContact('technical');
		expect((await runTest()).status).toBe(412);
	});

	it('sends the test to a verified contact that receives notifications, and says nothing else', async () => {
		const w = world();
		asMember('owner');
		await setContact('technical');
		await requestVerify();
		await confirm(tokenSent(w.mail));

		const sent = await runTest();
		expect(sent.json).toMatchObject({ sent: true });
		expect(w.mail.sent.at(-1)).toMatchObject({ input: { kind: 'test-notice' } });

		await setContact('technical', { ...CONTACT, notifyOn: false });
		const before = w.mail.sent.length;
		const off = await runTest();
		expect(off.json).toMatchObject({ sent: false });
		expect(w.mail.sent).toHaveLength(before);
	});
});

describe('organisation isolation', () => {
	it('refuses an owner the contact routes of another organisation', async () => {
		asMember('owner');
		expect((await listContacts(OTHER_ORG)).status).toBe(403);
		expect((await setContact('technical', CONTACT, OTHER_ORG)).status).toBe(403);
		expect((await requestVerify('technical', OTHER_ORG)).status).toBe(403);
		expect((await runTest('technical', OTHER_ORG)).status).toBe(403);
		expect((await setRecovery(CONTACT, OTHER_ORG)).status).toBe(403);
	});

	it('answers not found for a contact the other organisation does not hold', async () => {
		asMember('owner');
		await setContact('technical');

		asOtherOwner();
		expect((await requestVerify('technical', OTHER_ORG)).status).toBe(404);
		expect((await runTest('technical', OTHER_ORG)).status).toBe(404);
		expect(((await listContacts(OTHER_ORG)).json as { items: unknown[] }).items).toEqual([]);
	});
});

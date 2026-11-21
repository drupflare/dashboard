import type { CollegeDBClient } from '@earth-app/collegedb';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import procurementUpdate from '../../../../src/server/api/v1/orgs/[orgId]/procurement/[id].put';
import procurementExport from '../../../../src/server/api/v1/orgs/[orgId]/procurement/export.get';
import procurementList from '../../../../src/server/api/v1/orgs/[orgId]/procurement/index.get';
import procurementCreate from '../../../../src/server/api/v1/orgs/[orgId]/procurement/index.post';
import { SCHEMA_STATEMENTS } from '../../../../src/server/db/schema';
import {
	setProcurementServices,
	type ProcurementServices
} from '../../../../src/server/services/procurement';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { facts, fresh, member, ORG, OTHER_ORG } from '../../domain/fixtures';
import { asUser, send, setup } from '../fixtures/harness';

const NOW = 1_800_000_000_000;
const LIST = '/api/v1/orgs/:orgId/procurement';
const UPDATE = '/api/v1/orgs/:orgId/procurement/:id';
const EXPORT = '/api/v1/orgs/:orgId/procurement/export';

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
	let counter = 0;
	let tick = NOW;
	const services: ProcurementServices = {
		getDb: async () => db,
		newId: () => `${++counter}`,
		now: () => (tick += 1000)
	};
	setProcurementServices(services);
	return sql;
}

const asMember = (role: 'owner' | 'admin' | 'billing' | 'viewer' | 'developer') =>
	setup({ facts: () => facts({ ...member(role), ...fresh }) });

// the owner of the other organisation, acting on its own path
const asOtherOwner = () =>
	setup({
		facts: () => facts({ membership: { orgId: OTHER_ORG, role: 'owner' }, ...fresh })
	});

const quote = {
	kind: 'quote',
	reference: 'Q-1042',
	signatory: 'Pat Lee',
	amount: '=1+1',
	issuedOn: '2026-03-02',
	notes: 'Includes hosting'
};

const create = (orgId: string, body: unknown = quote) =>
	send(procurementCreate, LIST, {
		method: 'POST',
		path: `/api/v1/orgs/${orgId}/procurement`,
		headers: asUser,
		json: body
	});

const list = (orgId: string) =>
	send(procurementList, LIST, {
		path: `/api/v1/orgs/${orgId}/procurement`,
		headers: asUser
	});

afterEach(() => {
	setProcurementServices(null);
	resetApiDeps();
});

beforeEach(() => {
	resetApiDeps();
	world();
});

describe('creating and listing procurement records', () => {
	it('records a document as typed, with the amount kept as text and nothing totalled', async () => {
		asMember('owner');
		const reply = await create(ORG);
		expect(reply.status).toBe(201);
		expect(reply.json).toMatchObject({
			kind: 'quote',
			reference: 'Q-1042',
			signatory: 'Pat Lee',
			amount: '=1+1',
			issuedOn: '2026-03-02',
			dueOn: null,
			notes: 'Includes hosting'
		});
	});

	it('lists the records oldest first', async () => {
		asMember('owner');
		await create(ORG, { ...quote, reference: 'Q-1' });
		await create(ORG, { ...quote, reference: 'Q-2', kind: 'invoice' });
		const reply = await list(ORG);
		expect(
			(reply.json as { items: { reference: string }[] }).items.map((item) => item.reference)
		).toEqual(['Q-1', 'Q-2']);
	});

	it('refuses a field the form does not have, so a total or tax cannot be stored', async () => {
		asMember('owner');
		const reply = await create(ORG, { ...quote, total: '120.00' });
		expect(reply.status).toBe(400);
	});

	it('refuses a date that is not written as a calendar day', async () => {
		asMember('owner');
		expect((await create(ORG, { ...quote, issuedOn: '03/02/2026' })).status).toBe(400);
	});
});

describe('who may read and record', () => {
	it('lets billing record and read, and an admin read without recording', async () => {
		asMember('billing');
		expect((await create(ORG)).status).toBe(201);

		asMember('admin');
		expect((await list(ORG)).status).toBe(200);
		expect((await create(ORG)).status).toBe(403);
	});

	it('refuses a viewer and a developer the records', async () => {
		asMember('owner');
		await create(ORG);

		asMember('viewer');
		expect((await list(ORG)).status).toBe(403);
		asMember('developer');
		expect((await create(ORG)).status).toBe(403);
	});
});

describe('organisation isolation', () => {
	it('refuses an owner of one organisation the path of another', async () => {
		asMember('owner');
		expect((await list(OTHER_ORG)).status).toBe(403);
		expect((await create(OTHER_ORG)).status).toBe(403);
	});

	it('answers not found when another organisation names a record, and changes nothing', async () => {
		asMember('owner');
		const id = ((await create(ORG)).json as { id: string }).id;

		asOtherOwner();
		const reply = await send(procurementUpdate, UPDATE, {
			method: 'PUT',
			path: `/api/v1/orgs/${OTHER_ORG}/procurement/${id}`,
			headers: asUser,
			json: { ...quote, reference: 'Hijacked' }
		});
		expect(reply.status).toBe(404);
		expect(((await list(OTHER_ORG)).json as { items: unknown[] }).items).toEqual([]);

		asMember('owner');
		const kept = (await list(ORG)).json as { items: { reference: string }[] };
		expect(kept.items.map((item) => item.reference)).toEqual(['Q-1042']);
	});
});

describe('changing a record', () => {
	it('changes the fields in place and keeps the id and the first recorded time', async () => {
		asMember('owner');
		const first = (await create(ORG)).json as { id: string; createdAt: string };
		const reply = await send(procurementUpdate, UPDATE, {
			method: 'PUT',
			path: `/api/v1/orgs/${ORG}/procurement/${first.id}`,
			headers: asUser,
			json: { ...quote, kind: 'po', reference: 'PO-9' }
		});
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({
			id: first.id,
			kind: 'po',
			reference: 'PO-9',
			createdAt: first.createdAt
		});
	});
});

describe('CSV export', () => {
	it('exports the records with a formula-looking amount written as text', async () => {
		asMember('owner');
		await create(ORG);
		const reply = await send(procurementExport, EXPORT, {
			path: `/api/v1/orgs/${ORG}/procurement/export`,
			headers: asUser
		});
		expect(reply.status).toBe(200);
		expect(reply.headers.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(reply.text).toContain('Kind,Reference,Signatory,Amount');
		expect(reply.text).toContain(",'=1+1,");
		expect(reply.text).toContain('Quote,Q-1042,Pat Lee,');
	});

	it('refuses the export to a viewer', async () => {
		asMember('owner');
		await create(ORG);
		asMember('viewer');
		const reply = await send(procurementExport, EXPORT, {
			path: `/api/v1/orgs/${ORG}/procurement/export`,
			headers: asUser
		});
		expect(reply.status).toBe(403);
	});
});

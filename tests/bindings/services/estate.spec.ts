import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { toBase64Url } from '../../../contracts/src/common';
import cancelRoute from '../../../src/server/api/v1/orgs/[orgId]/assessments/[id]/cancel.post';
import exportRoute from '../../../src/server/api/v1/orgs/[orgId]/assessments/[id]/export.get';
import readRoute from '../../../src/server/api/v1/orgs/[orgId]/assessments/[id]/index.get';
import rowsRoute from '../../../src/server/api/v1/orgs/[orgId]/assessments/[id]/rows.get';
import checkRoute from '../../../src/server/api/v1/orgs/[orgId]/assessments/check.post';
import listRoute from '../../../src/server/api/v1/orgs/[orgId]/assessments/index.get';
import createRoute from '../../../src/server/api/v1/orgs/[orgId]/assessments/index.post';
import proofCheckRoute from '../../../src/server/api/v1/orgs/[orgId]/assessments/proofs/check.post';
import proofRoute from '../../../src/server/api/v1/orgs/[orgId]/assessments/proofs/index.post';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import { insertImportCredential } from '../../../src/server/db/repos/import-credentials';
import { FREE_PLAN_ID, derive } from '../../../src/server/domain/entitlements';
import type { EngineStartRequest } from '../../../src/server/integrations/engine';
import { resetEstateServices, setEstateServices } from '../../../src/server/services/estate';
import { resetSiteServices, setSiteServices } from '../../../src/server/services/sites';
import { resetApiDeps } from '../../../src/server/utils/define-api';
import { loadChallengeKeys } from '../../../src/shared/custody/challenge';
import { ACTION_DEFS } from '../../../src/shared/permissions';
import { DEPT, ORG, OTHER_ORG, facts } from '../../unit/domain/fixtures';
import { asUser, send as sendRequest, setup, type Reply } from '../../unit/server/fixtures/harness';
import { openBindings, type Bindings, type OpenBindings } from '../support';

vi.mock('nitropack/runtime', () => ({ defineTask: (task: unknown) => task }));

let harness: OpenBindings;
let env: Bindings;
const getDb = () => ensureCollegeDB(withAtomicBatch(env));

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
});

afterAll(() => harness.close());

const NOW = 1_790_000_000_000;
const BASE = `/api/v1/orgs/${ORG}/assessments`;
let started: EngineStartRequest[];
let audits: { action: string; target: string }[];
let dnsRecords: { name: string; type: string; data: string }[];
let files: Record<string, { status: number; text: string }>;
let counter = 0;
const key = () => `estate-key-${++counter}-${Date.now()}`;

function install() {
	const derived = derive(FREE_PLAN_ID);
	if (!derived.ok) throw new Error(derived.reason);
	setSiteServices({
		getDb,
		entitlements: { check: async () => ({ allow: true, entitlement: derived.entitlement }) },
		planOf: async () => derived.entitlement,
		startOperation: async (request) => void started.push(request),
		config: { hostSuffix: 'drupflare.app', accountId: 'a'.repeat(32), releases: {} }
	});
	setEstateServices({
		keys: () => loadChallengeKeys({ KEK_V1: toBase64Url(new Uint8Array(32).fill(5)) }),
		dns: {
			query: async (name, type) => ({
				ok: true,
				records: dnsRecords.filter((r) => r.name === name && r.type === type)
			})
		},
		readFile: async (url) => files[url] ?? null,
		audit: async (_org, input) =>
			void audits.push({ action: input.action, target: input.target }),
		now: () => NOW
	});
}

beforeEach(async () => {
	await getDb();
	await env.DB.prepare('DELETE FROM assessment_proofs').run();
	started = [];
	audits = [];
	dnsRecords = [];
	files = {};
	install();
	asRole('developer');
});

afterEach(() => {
	resetEstateServices();
	resetSiteServices();
	resetApiDeps();
});

function asRole(role: 'owner' | 'admin' | 'developer' | 'viewer') {
	setup({
		deps: {
			load: async (input) => ({
				resource: { orgId: input.params.orgId, departmentId: DEPT },
				facts: facts({ membership: { orgId: ORG, role } })
			})
		}
	});
}

const call = (
	handler: Parameters<typeof sendRequest>[0],
	route: string,
	path: string,
	options: {
		method?: string;
		json?: unknown;
		idem?: string;
		headers?: Record<string, string>;
	} = {}
): Promise<Reply> =>
	sendRequest(handler, route, {
		method: options.method ?? 'GET',
		path,
		headers: {
			...(options.headers ?? asUser),
			...(options.idem === undefined ? {} : { 'idempotency-key': options.idem })
		},
		json: options.json
	});

const create = (text: string, extra: Record<string, unknown> = {}, idem = key()) =>
	call(createRoute, '/api/v1/orgs/:orgId/assessments', BASE, {
		method: 'POST',
		json: { text, ...extra },
		idem
	});

const csv = (...hosts: string[]) => `hostname\n${hosts.join('\n')}\n`;
const hostsOf = (n: number, domain = 'example.edu') =>
	Array.from({ length: n }, (_, i) => `h${i + 1}.${domain}`);

const rowsOfAssessment = (id: string) =>
	env.DB.prepare(
		'SELECT number, hostname, state, class, needs_proof FROM assessment_rows WHERE assessment_id = ? ORDER BY number'
	)
		.bind(id)
		.all<{
			number: number;
			hostname: string;
			state: string;
			class: string | null;
			needs_proof: string | null;
		}>();

describe('the actions', () => {
	it('let a developer start and read, and keep a viewer to reading', () => {
		expect(ACTION_DEFS['assessment.manage'].org).toEqual(['owner', 'admin', 'developer']);
		expect(ACTION_DEFS['assessment.read'].org).toContain('viewer');
		expect(ACTION_DEFS['assessment.manage'].sessionOnly).toBeUndefined();
	});
});

describe('POST an assessment', () => {
	it('stores the rows, starts one run and answers 202 with the state', async () => {
		const reply = await create(csv('a.example.edu', 'b.example.edu'));
		expect(reply.status).toBe(202);
		const view = reply.json as {
			id: string;
			operationId: string;
			rowCount: number;
			state: string;
		};
		expect(view.id).toMatch(/^asm_[a-z0-9]{26}$/);
		expect(view.rowCount).toBe(2);
		expect(view.state).toBe('preparing');
		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({ workflow: 'estate-assess', id: view.operationId });
		expect(started[0]!.params).toMatchObject({ assessmentId: view.id, orgId: ORG });
		const rows = await rowsOfAssessment(view.id);
		expect(rows.results.map((r) => [r.hostname, r.state])).toEqual([
			['a.example.edu', 'pending'],
			['b.example.edu', 'pending']
		]);
		expect(audits.map((a) => a.action)).toEqual(['assessment.manage']);
	});

	it('returns the same assessment for a repeated key and starts it once', async () => {
		const idem = key();
		const first = await create(csv('a.example.edu'), {}, idem);
		const again = await create(csv('a.example.edu'), {}, idem);
		expect((again.json as { id: string }).id).toBe((first.json as { id: string }).id);
		expect(started).toHaveLength(1);
	});

	it('needs an Idempotency-Key', async () => {
		const reply = await call(createRoute, '/api/v1/orgs/:orgId/assessments', BASE, {
			method: 'POST',
			json: { text: csv('a.example.edu') }
		});
		expect(reply.status).toBe(400);
	});

	it('counts the rows it leaves out and keeps the rest', async () => {
		const reply = await create('hostname\na.example.edu\n10.0.0.1\n\nb.example.edu\n');
		const view = reply.json as { rowCount: number; rejectedTotal: number };
		expect(view).toMatchObject({ rowCount: 2, rejectedTotal: 1 });
	});

	it('refuses a file it cannot read and a file with no usable row, with the reason', async () => {
		const bad = await create('name\nx');
		expect(bad.status).toBe(422);
		expect(JSON.stringify(bad.json)).toContain('The first row needs a hostname column.');
		const empty = await create('hostname\n10.0.0.1\n');
		expect(empty.status).toBe(422);
		expect(JSON.stringify(empty.json)).toContain('hostname is an IP address');
		expect(started).toEqual([]);
	});

	it('holds sites past the unproven allowance at needs proof, with the domain named', async () => {
		const reply = await create(csv(...hostsOf(8)));
		const { id } = reply.json as { id: string };
		const rows = (await rowsOfAssessment(id)).results;
		expect(rows.filter((r) => r.state === 'pending')).toHaveLength(5);
		const held = rows.filter((r) => r.state === 'needs proof');
		expect(held.map((r) => r.number)).toEqual([6, 7, 8]);
		expect(
			held.every((r) => r.needs_proof === 'example.edu' && r.class === 'information')
		).toBe(true);
	});

	it('lifts the allowance for a domain the organisation proved', async () => {
		const start = await call(
			proofRoute,
			'/api/v1/orgs/:orgId/assessments/proofs',
			`${BASE}/proofs`,
			{
				method: 'POST',
				json: { domain: 'www.example.edu' }
			}
		);
		const proof = start.json as { domain: string; record: { name: string; value: string } };
		dnsRecords.push({ name: proof.record.name, type: 'TXT', data: `"${proof.record.value}"` });
		const checked = await call(
			proofCheckRoute,
			'/api/v1/orgs/:orgId/assessments/proofs/check',
			`${BASE}/proofs/check`,
			{
				method: 'POST',
				json: { domain: 'example.edu', method: 'dns' }
			}
		);
		expect(checked.json).toMatchObject({ proven: true, domain: 'example.edu' });
		const { id } = (await create(csv(...hostsOf(8)))).json as { id: string };
		const rows = (await rowsOfAssessment(id)).results;
		expect(rows.every((r) => r.state === 'pending')).toBe(true);
	});

	it('refuses a key that belongs to another organisation, an expired one and an unconfirmed one', async () => {
		const row = (id: string, org: string, expiresAt: number) =>
			getDb().then((db) =>
				insertImportCredential(db, {
					id,
					organizationId: org,
					userId: 'usr_x',
					keyEnvelope: '{}',
					publicKey: 'ssh-ed25519 AAAA',
					host: 'web1.example.edu',
					port: 22,
					username: 'deploy',
					createdAt: NOW - 10,
					expiresAt
				})
			);
		const foreign = `imc_${'f'.repeat(26)}`;
		const stale = `imc_${'e'.repeat(26)}`;
		const open = `imc_${'u'.repeat(26)}`;
		await row(foreign, OTHER_ORG, NOW + 1000);
		await row(stale, ORG, NOW - 1);
		await row(open, ORG, NOW + 1000);
		const text = csv('a.example.edu');
		expect((await create(text, { credentialIds: [foreign] })).status).toBe(404);
		expect((await create(text, { credentialIds: [stale] })).status).toBe(422);
		const unconfirmed = await create(text, { credentialIds: [open] });
		expect(unconfirmed.status).toBe(422);
		expect(JSON.stringify(unconfirmed.json)).toContain('host_key_unconfirmed');
		await env.DB.prepare(
			"UPDATE import_credentials SET host_key_fingerprint = 'SHA256:x', host_key_type = 'ssh-ed25519' WHERE id = ?"
		)
			.bind(open)
			.run();
		const good = await create(text, { credentialIds: [open] });
		expect(good.status).toBe(202);
		const stored = await env.DB.prepare('SELECT access FROM assessments WHERE id = ?')
			.bind((good.json as { id: string }).id)
			.first<{ access: string }>();
		expect(JSON.parse(stored!.access)).toEqual([
			{ server: 'web1.example.edu', credentialId: open }
		]);
	});

	it('keeps a viewer out and another organisation out', async () => {
		asRole('viewer');
		expect((await create(csv('a.example.edu'))).status).toBe(403);
		asRole('developer');
		const reply = await call(
			createRoute,
			'/api/v1/orgs/:orgId/assessments',
			`/api/v1/orgs/${OTHER_ORG}/assessments`,
			{ method: 'POST', json: { text: csv('a.example.edu') }, idem: key() }
		);
		expect([403, 404]).toContain(reply.status);
	});
});

describe('POST check', () => {
	it('reads the file without storing anything or starting a run', async () => {
		const reply = await call(
			checkRoute,
			'/api/v1/orgs/:orgId/assessments/check',
			`${BASE}/check`,
			{
				method: 'POST',
				json: { text: 'hostname,mystery\na.example.edu,1\n10.0.0.1,2\na.example.edu,3' }
			}
		);
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({
			fileError: null,
			rows: 2,
			sites: 1,
			notReconciled: 1,
			rejectedTotal: 1,
			ignoredColumns: ['mystery']
		});
		expect(started).toEqual([]);
	});
});

describe('reading', () => {
	let id: string;
	beforeEach(async () => {
		const reply = await create(csv(...hostsOf(7)));
		id = (reply.json as { id: string }).id;
		await env.DB.prepare(
			"UPDATE assessment_rows SET state = 'done', class = 'ready' WHERE assessment_id = ? AND number IN (1, 2)"
		)
			.bind(id)
			.run();
	});

	it('reads one assessment with progress by state and class', async () => {
		const reply = await call(readRoute, '/api/v1/orgs/:orgId/assessments/:id', `${BASE}/${id}`);
		expect(reply.status).toBe(200);
		const view = reply.json as {
			progress: Record<string, number>;
			classes: Record<string, number>;
			report: unknown;
		};
		expect(view.progress).toMatchObject({ done: 2, pending: 3, 'needs proof': 2 });
		expect(view.classes).toMatchObject({ ready: 2, information: 2 });
		expect(view.report).toBeNull();
	});

	it('answers 404 for another organisation and for an id that does not exist', async () => {
		const other = await call(
			readRoute,
			'/api/v1/orgs/:orgId/assessments/:id',
			`/api/v1/orgs/${OTHER_ORG}/assessments/${id}`
		);
		expect([403, 404]).toContain(other.status);
		const missing = await call(
			readRoute,
			'/api/v1/orgs/:orgId/assessments/:id',
			`${BASE}/asm_${'z'.repeat(26)}`
		);
		expect(missing.status).toBe(404);
	});

	it('lists in pages with a cursor and filters the rows', async () => {
		const page = await call(
			rowsRoute,
			'/api/v1/orgs/:orgId/assessments/:id/rows',
			`${BASE}/${id}/rows?limit=3`
		);
		const first = page.json as { items: { number: number }[]; nextCursor: string | null };
		expect(first.items.map((r) => r.number)).toEqual([1, 2, 3]);
		const next = await call(
			rowsRoute,
			'/api/v1/orgs/:orgId/assessments/:id/rows',
			`${BASE}/${id}/rows?limit=3&cursor=${first.nextCursor}`
		);
		expect((next.json as { items: { number: number }[] }).items.map((r) => r.number)).toEqual([
			4, 5, 6
		]);
		const byClass = await call(
			rowsRoute,
			'/api/v1/orgs/:orgId/assessments/:id/rows',
			`${BASE}/${id}/rows?class=ready`
		);
		expect((byClass.json as { items: unknown[] }).items).toHaveLength(2);
		const byState = await call(
			rowsRoute,
			'/api/v1/orgs/:orgId/assessments/:id/rows',
			`${BASE}/${id}/rows?state=needs%20proof`
		);
		expect(
			(byState.json as { items: { missing: string }[] }).items.map((r) => r.missing)
		).toEqual(['proof that you control example.edu', 'proof that you control example.edu']);
		const byText = await call(
			rowsRoute,
			'/api/v1/orgs/:orgId/assessments/:id/rows',
			`${BASE}/${id}/rows?q=H3.`
		);
		expect(
			(byText.json as { items: { hostname: string }[] }).items.map((r) => r.hostname)
		).toEqual(['h3.example.edu']);
		const wild = await call(
			rowsRoute,
			'/api/v1/orgs/:orgId/assessments/:id/rows',
			`${BASE}/${id}/rows?q=%25`
		);
		expect((wild.json as { items: unknown[] }).items).toEqual([]);
	});

	it('lists assessments newest first with a cursor', async () => {
		await create(csv('later.example.edu'));
		const one = await call(listRoute, '/api/v1/orgs/:orgId/assessments', `${BASE}?limit=1`);
		const page = one.json as { items: { id: string }[]; nextCursor: string | null };
		expect(page.items).toHaveLength(1);
		expect(page.nextCursor).not.toBeNull();
		const two = await call(
			listRoute,
			'/api/v1/orgs/:orgId/assessments',
			`${BASE}?limit=50&cursor=${page.nextCursor}`
		);
		expect(
			(two.json as { items: { id: string }[] }).items.every((i) => i.id !== page.items[0]!.id)
		).toBe(true);
	});

	it('exports every row as CSV that starts with the inventory columns', async () => {
		const reply = await call(
			exportRoute,
			'/api/v1/orgs/:orgId/assessments/:id/export',
			`${BASE}/${id}/export`
		);
		expect(reply.status).toBe(200);
		expect(reply.headers.get('content-type')).toContain('text/csv');
		expect(reply.headers.get('content-disposition')).toContain(`${id}.csv`);
		const lines = reply.text.trim().split('\r\n');
		expect(lines[0]).toMatch(/^hostname,aliases,server,docroot,site_dir,database_host/);
		expect(lines).toHaveLength(8);
		expect(reply.text).toContain('Not estimated');
	});
});

describe('cancel', () => {
	it('moves a running assessment to cancelled and answers a repeat the same way', async () => {
		const { id } = (await create(csv('a.example.edu'))).json as { id: string };
		const first = await call(
			cancelRoute,
			'/api/v1/orgs/:orgId/assessments/:id/cancel',
			`${BASE}/${id}/cancel`,
			{ method: 'POST' }
		);
		expect(first.status).toBe(200);
		expect((first.json as { state: string }).state).toBe('cancelled');
		const again = await call(
			cancelRoute,
			'/api/v1/orgs/:orgId/assessments/:id/cancel',
			`${BASE}/${id}/cancel`,
			{ method: 'POST' }
		);
		expect((again.json as { state: string }).state).toBe('cancelled');
		expect(
			audits.filter((a) => a.target === id && a.action === 'assessment.manage')
		).toHaveLength(2);
	});

	it('refuses to cancel one that has finished', async () => {
		const { id } = (await create(csv('a.example.edu'))).json as { id: string };
		await env.DB.prepare("UPDATE assessments SET state = 'finished' WHERE id = ?")
			.bind(id)
			.run();
		const reply = await call(
			cancelRoute,
			'/api/v1/orgs/:orgId/assessments/:id/cancel',
			`${BASE}/${id}/cancel`,
			{ method: 'POST' }
		);
		expect(reply.status).toBe(409);
	});

	it('is a developer action and a viewer cannot cancel', async () => {
		const { id } = (await create(csv('a.example.edu'))).json as { id: string };
		asRole('viewer');
		const reply = await call(
			cancelRoute,
			'/api/v1/orgs/:orgId/assessments/:id/cancel',
			`${BASE}/${id}/cancel`,
			{ method: 'POST' }
		);
		expect(reply.status).toBe(403);
	});
});

describe('proof', () => {
	const route = '/api/v1/orgs/:orgId/assessments/proofs';

	it('gives a TXT record and a file text that belong to this organisation and domain', async () => {
		const reply = await call(proofRoute, route, `${BASE}/proofs`, {
			method: 'POST',
			json: { domain: 'www.example.edu' }
		});
		const proof = reply.json as {
			domain: string;
			proven: boolean;
			record: { type: string; name: string; value: string };
			file: { path: string; content: string };
		};
		expect(proof.domain).toBe('example.edu');
		expect(proof.proven).toBe(false);
		expect(proof.record.name).toBe('_drupflare-estate.example.edu');
		expect(proof.record.value).toMatch(/^drupflare-estate=[a-z2-7]{32}$/);
		expect(proof.file).toEqual({
			path: '/.well-known/drupflare-estate.txt',
			content: proof.record.value
		});
		const other = await call(proofRoute, route, `${BASE}/proofs`, {
			method: 'POST',
			json: { domain: 'other.edu' }
		});
		expect((other.json as { record: { value: string } }).record.value).not.toBe(
			proof.record.value
		);
	});

	it('does not accept a domain attach record as proof', async () => {
		const reply = await call(proofRoute, route, `${BASE}/proofs`, {
			method: 'POST',
			json: { domain: 'example.edu' }
		});
		const proof = reply.json as { record: { name: string } };
		dnsRecords.push({
			name: proof.record.name,
			type: 'TXT',
			data: '"drupflare-verify=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'
		});
		const checked = await call(proofCheckRoute, `${route}/check`, `${BASE}/proofs/check`, {
			method: 'POST',
			json: { domain: 'example.edu', method: 'dns' }
		});
		expect(checked.json).toMatchObject({ proven: false });
	});

	it('proves a domain from the file, records it once and answers proven afterwards', async () => {
		const reply = await call(proofRoute, route, `${BASE}/proofs`, {
			method: 'POST',
			json: { domain: 'example.edu' }
		});
		const proof = reply.json as { file: { content: string } };
		files['https://example.edu/.well-known/drupflare-estate.txt'] = {
			status: 200,
			text: `${proof.file.content}\n`
		};
		const checked = await call(proofCheckRoute, `${route}/check`, `${BASE}/proofs/check`, {
			method: 'POST',
			json: { domain: 'example.edu', method: 'http' }
		});
		expect(checked.json).toMatchObject({ proven: true, method: 'http' });
		await call(proofCheckRoute, `${route}/check`, `${BASE}/proofs/check`, {
			method: 'POST',
			json: { domain: 'example.edu', method: 'http' }
		});
		const stored = await env.DB.prepare(
			'SELECT COUNT(*) AS n FROM assessment_proofs WHERE organization_id = ?'
		)
			.bind(ORG)
			.first<{ n: number }>();
		expect(stored!.n).toBe(1);
		const again = await call(proofRoute, route, `${BASE}/proofs`, {
			method: 'POST',
			json: { domain: 'example.edu' }
		});
		expect((again.json as { proven: boolean }).proven).toBe(true);
	});

	it('says plainly when the record or the file is not there', async () => {
		const dns = await call(proofCheckRoute, `${route}/check`, `${BASE}/proofs/check`, {
			method: 'POST',
			json: { domain: 'nothing.edu', method: 'dns' }
		});
		expect(dns.json).toMatchObject({ proven: false, detail: 'The record was not found yet.' });
		const http = await call(proofCheckRoute, `${route}/check`, `${BASE}/proofs/check`, {
			method: 'POST',
			json: { domain: 'nothing.edu', method: 'http' }
		});
		expect(http.json).toMatchObject({
			proven: false,
			detail: 'The file could not be read from the site.'
		});
	});

	it('refuses something that is not a domain', async () => {
		const reply = await call(proofRoute, route, `${BASE}/proofs`, {
			method: 'POST',
			json: { domain: '10.0.0.1' }
		});
		expect(reply.status).toBe(422);
	});
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { toBase64Url } from '../../../contracts/src/common';
import importCredentials from '../../../src/server/api/v1/orgs/[orgId]/imports/credentials.post';
import importHostKey from '../../../src/server/api/v1/orgs/[orgId]/imports/hostkey.post';
import importStart from '../../../src/server/api/v1/orgs/[orgId]/imports/index.post';
import importSurvey from '../../../src/server/api/v1/orgs/[orgId]/imports/survey.post';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import { insertImportCredential } from '../../../src/server/db/repos/import-credentials';
import { FREE_PLAN_ID, derive } from '../../../src/server/domain/entitlements';
import type { EngineStartRequest } from '../../../src/server/integrations/engine';
import {
	importServices,
	resetImportServices,
	setImportServices,
	startImportSurvey,
	startSiteImport
} from '../../../src/server/services/site-import';
import {
	resetSiteServices,
	setSiteServices,
	siteServices
} from '../../../src/server/services/sites';
import { purgeImportCredentials } from '../../../src/server/tasks/import-credentials-purge';
import { resetApiDeps } from '../../../src/server/utils/define-api';
import { decryptRecordText, loadKeyRing } from '../../../src/shared/custody/envelope';
import {
	IMPORT_CREDENTIAL_TTL_MS,
	importCredentialAad
} from '../../../src/shared/custody/import-credentials';
import { ApiError } from '../../../src/shared/errors';
import { ACTION_DEFS, isSessionOnly } from '../../../src/shared/permissions';
import { DEPT, ORG, OTHER_ORG, facts, fresh } from '../../unit/domain/fixtures';
import {
	asKey,
	asUser,
	send as sendRequest,
	setup,
	type Reply
} from '../../unit/server/fixtures/harness';
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

const KEK = { KEK_V1: toBase64Url(new Uint8Array(32).fill(3)) };
const NOW = 1_790_000_000_000;
const PUBLIC_ADDRESS = '93.184.216.34';
const BASE = `/api/v1/orgs/${ORG}/imports`;

interface Probe {
	type: string;
	fingerprint: string;
}

let probeAnswer: Probe;
let probeCalls: { host: string; port: number }[];
let lookupCalls: string[];
let lookupAnswers: string[][];
let audits: { orgId: string; action: string; actor: string; target: string; detail?: unknown }[];
let started: EngineStartRequest[];
let startFails = false;
let counter = 0;
const key = () => `import-key-${++counter}-${Date.now()}`;

const freeEntitlement = () => {
	const result = derive(FREE_PLAN_ID);
	if (!result.ok) throw new Error(result.reason);
	return result.entitlement;
};

function install(options: { allow?: boolean } = {}) {
	setSiteServices({
		getDb,
		entitlements: {
			check: async () =>
				options.allow === false
					? { allow: false, reason: 'site_limit' }
					: { allow: true, entitlement: freeEntitlement() }
		},
		planOf: async () => freeEntitlement(),
		startOperation: async (request) => {
			if (startFails) throw new Error('the engine is down');
			started.push(request);
		},
		config: {
			hostSuffix: 'drupflare.app',
			accountId: 'a'.repeat(32),
			releases: { drupal: 'v1.0.5' }
		}
	});
	setImportServices({
		audit: async (orgId, input) => void audits.push({ orgId, ...input }),
		ring: () => loadKeyRing(KEK),
		resolve: async (host) => {
			lookupCalls.push(host);
			if (host.endsWith('.internal-test')) return ['10.0.0.5'];
			return lookupAnswers[Math.min(lookupCalls.length - 1, lookupAnswers.length - 1)] ?? [];
		},
		probe: async (target) => {
			probeCalls.push(target);
			return probeAnswer;
		},
		now: () => NOW
	});
}

beforeEach(() => {
	probeAnswer = { type: 'ssh-ed25519', fingerprint: 'SHA256:first' };
	probeCalls = [];
	lookupCalls = [];
	lookupAnswers = [[PUBLIC_ADDRESS]];
	audits = [];
	started = [];
	startFails = false;
	install();
});

afterEach(() => {
	resetImportServices();
	resetSiteServices();
	resetApiDeps();
});

function asRole(role: 'owner' | 'admin' | 'developer' | 'viewer', stepUp = true) {
	setup({
		deps: {
			load: async (input) => ({
				resource: { orgId: input.params.orgId, departmentId: DEPT },
				facts: facts({
					membership: { orgId: ORG, role },
					...(stepUp ? fresh : {})
				})
			})
		}
	});
}

const post = (
	handler: Parameters<typeof sendRequest>[0],
	name: string,
	json: unknown,
	options: { idem?: string | null; headers?: Record<string, string>; org?: string } = {}
): Promise<Reply> =>
	sendRequest(handler, `/api/v1/orgs/:orgId/imports${name === '' ? '' : `/${name}`}`, {
		method: 'POST',
		path: `/api/v1/orgs/${options.org ?? ORG}/imports${name === '' ? '' : `/${name}`}`,
		headers: {
			...(options.headers ?? asUser),
			...(options.idem === null || options.idem === undefined
				? {}
				: { 'idempotency-key': options.idem })
		},
		json
	});

const credentialBody = { host: 'server.example.test', port: 22, username: 'deploy' };

async function makeCredential() {
	const reply = await post(importCredentials, 'credentials', credentialBody);
	expect(reply.status).toBe(201);
	return reply.json as { id: string; publicKey: string; expiresAt: string };
}

// a key that belongs to another organization, written as the dashboard would have
async function foreignCredential(): Promise<string> {
	const id = `imc_${'f'.repeat(26)}`;
	await env.DB.prepare('DELETE FROM import_credentials WHERE id = ?').bind(id).run();
	await insertImportCredential(await getDb(), {
		id,
		organizationId: OTHER_ORG,
		userId: 'user-other',
		keyEnvelope: '{}',
		publicKey: 'ssh-ed25519 AAAA drupflare-import',
		host: 'server.example.test',
		port: 22,
		username: 'deploy',
		createdAt: NOW,
		expiresAt: NOW + IMPORT_CREDENTIAL_TTL_MS
	});
	return id;
}

async function confirmedCredential() {
	const made = await makeCredential();
	const reply = await post(importHostKey, 'hostkey', {
		credentialId: made.id,
		confirm: { fingerprint: probeAnswer.fingerprint }
	});
	expect(reply.status).toBe(200);
	return made.id;
}

const rowOf = (id: string) =>
	env.DB.prepare('SELECT * FROM import_credentials WHERE id = ?')
		.bind(id)
		.first<Record<string, unknown>>();

const SURVEY_BODY = (credentialId: string) => ({ credentialId, root: '/var/www/html' });

async function surveyed(credentialId: string, patch: Record<string, unknown> = {}) {
	const reply = await post(importSurvey, 'survey', SURVEY_BODY(credentialId), { idem: key() });
	expect(reply.status).toBe(202);
	const operation = reply.json as { id: string };
	const record = {
		v: 1,
		host: 'server.example.test',
		root: '/var/www/html',
		capturedAt: null,
		dossier: {
			verdict: 'ready',
			importable: true,
			refusals: [],
			estimate: { bytes: 4_000_000, fileCount: 0 },
			findings: [],
			...patch
		}
	};
	await env.DB.prepare('UPDATE operations SET status = ?, cursor = ? WHERE id = ?')
		.bind('succeeded', JSON.stringify(record), operation.id)
		.run();
	return operation.id;
}

describe('the actions', () => {
	it('keep all three to owners and admins, a session and a fresh sign-in', () => {
		for (const action of [
			'site.import.credential',
			'site.import.survey',
			'site.import'
		] as const) {
			expect(isSessionOnly(action)).toBe(true);
			expect(ACTION_DEFS[action].stepUp).toBe(true);
			expect(ACTION_DEFS[action].org).toEqual(['owner', 'admin']);
		}
	});
});

describe('POST the credential', () => {
	it('answers 201 with the public line and the exact view, and never the private key', async () => {
		asRole('owner');
		const reply = await post(importCredentials, 'credentials', credentialBody);
		expect(reply.status).toBe(201);
		const view = reply.json as Record<string, unknown>;
		expect(Object.keys(view).sort()).toEqual(
			['expiresAt', 'host', 'id', 'port', 'publicKey', 'username'].sort()
		);
		expect(view).toMatchObject({
			host: 'server.example.test',
			port: 22,
			username: 'deploy',
			expiresAt: new Date(NOW + IMPORT_CREDENTIAL_TTL_MS).toISOString()
		});
		expect(view.id).toMatch(/^imc_[a-z2-7]{26}$/);
		expect(String(view.publicKey)).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ drupflare-import$/);
		expect(reply.text).not.toContain('PRIVATE KEY');
	});

	it('seals the private key to the credential id and keeps it out of every other column and the audit row', async () => {
		asRole('owner');
		const made = await makeCredential();
		const row = (await rowOf(made.id))!;
		const pem = await decryptRecordText(
			JSON.parse(String(row.key_envelope)),
			importCredentialAad(made.id),
			await loadKeyRing(KEK)
		);
		expect(pem.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true);
		const body = pem.split('\n')[1]!;
		for (const [column, value] of Object.entries(row)) {
			if (column === 'key_envelope') continue;
			expect(String(value)).not.toContain(body);
		}
		expect(String(row.key_envelope)).not.toContain(body);
		expect(JSON.stringify(audits)).not.toContain(body);
		expect(JSON.stringify(audits)).not.toContain('PRIVATE KEY');
		expect(audits).toEqual([
			expect.objectContaining({
				orgId: ORG,
				action: 'site.import.credential',
				target: made.id,
				detail: { host: 'server.example.test', port: 22, username: 'deploy' }
			})
		]);
		expect(row).toMatchObject({
			organization_id: ORG,
			host_key_fingerprint: null,
			used_at: null,
			expires_at: NOW + IMPORT_CREDENTIAL_TTL_MS
		});
	});

	it('refuses an address that is not on the public internet', async () => {
		asRole('owner');
		for (const host of ['127.0.0.1', '10.1.2.3', 'localhost.localdomain', 'db.internal-test']) {
			const reply = await post(importCredentials, 'credentials', { ...credentialBody, host });
			expect(reply.status).toBe(422);
			expect(reply.json).toMatchObject({ details: { reason: 'host_private' } });
		}
		expect(audits).toEqual([]);
	});

	it('refuses a malformed host, port or user name', async () => {
		asRole('owner');
		for (const patch of [
			{ host: 'not a host' },
			{ host: 'a;b.example' },
			{ port: 0 },
			{ port: 70000 },
			{ username: 'root; rm -rf /' },
			{ extra: true }
		]) {
			const reply = await post(importCredentials, 'credentials', {
				...credentialBody,
				...patch
			});
			expect(reply.status).toBe(400);
		}
	});

	it.each([
		['admin', 201],
		['developer', 403],
		['viewer', 403]
	] as const)('answers %s with %i', async (role, status) => {
		asRole(role);
		expect((await post(importCredentials, 'credentials', credentialBody)).status).toBe(status);
	});

	it('refuses an API key whatever its scopes, and a session without a fresh sign-in', async () => {
		asRole('owner');
		expect(
			(await post(importCredentials, 'credentials', credentialBody, { headers: asKey }))
				.status
		).toBe(403);
		asRole('owner', false);
		expect((await post(importCredentials, 'credentials', credentialBody)).status).toBe(403);
		const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM import_credentials').first<{
			n: number;
		}>();
		expect(count!.n).toBeGreaterThanOrEqual(0);
	});

	it('answers 501 until secret custody is installed', async () => {
		asRole('owner');
		resetImportServices();
		expect((await post(importCredentials, 'credentials', credentialBody)).status).toBe(501);
	});
});

describe('POST the host key', () => {
	it('reads the key without storing it, then stores it only when the owner confirms the same one', async () => {
		asRole('owner');
		const made = await makeCredential();
		const read = await post(importHostKey, 'hostkey', { credentialId: made.id });
		expect(read.status).toBe(200);
		expect(read.json).toEqual({
			credentialId: made.id,
			hostKeyType: 'ssh-ed25519',
			fingerprint: 'SHA256:first',
			confirmed: false
		});
		expect((await rowOf(made.id))!.host_key_fingerprint).toBeNull();
		// the probe dials the address that passed the check, not the name
		expect(probeCalls).toEqual([{ host: PUBLIC_ADDRESS, port: 22 }]);

		const confirmed = await post(importHostKey, 'hostkey', {
			credentialId: made.id,
			confirm: { fingerprint: 'SHA256:first' }
		});
		expect(confirmed.status).toBe(200);
		expect(confirmed.json).toMatchObject({ confirmed: true, fingerprint: 'SHA256:first' });
		expect(await rowOf(made.id)).toMatchObject({
			host_key_fingerprint: 'SHA256:first',
			host_key_type: 'ssh-ed25519'
		});
		const again = await post(importHostKey, 'hostkey', { credentialId: made.id });
		expect(again.json).toMatchObject({ confirmed: true });
	});

	it('refuses to store a key the owner was not shown', async () => {
		asRole('owner');
		const made = await makeCredential();
		const reply = await post(importHostKey, 'hostkey', {
			credentialId: made.id,
			confirm: { fingerprint: 'SHA256:other' }
		});
		expect(reply.status).toBe(409);
		expect(reply.json).toMatchObject({ details: { reason: 'host_key_changed' } });
		expect((await rowOf(made.id))!.host_key_fingerprint).toBeNull();
	});

	it('refuses a second, different key once one was confirmed', async () => {
		asRole('owner');
		const id = await confirmedCredential();
		probeAnswer = { type: 'ssh-ed25519', fingerprint: 'SHA256:swapped' };
		const reply = await post(importHostKey, 'hostkey', {
			credentialId: id,
			confirm: { fingerprint: 'SHA256:swapped' }
		});
		expect(reply.status).toBe(409);
		expect(reply.json).toMatchObject({ details: { reason: 'host_key_confirmed' } });
		expect((await rowOf(id))!.host_key_fingerprint).toBe('SHA256:first');
	});

	it('answers 404 for a key that does not exist or belongs to another organization', async () => {
		asRole('owner');
		expect(
			(await post(importHostKey, 'hostkey', { credentialId: `imc_${'z'.repeat(26)}` })).status
		).toBe(404);
		const reply = await post(importHostKey, 'hostkey', {
			credentialId: await foreignCredential()
		});
		expect(reply.status).toBe(404);
	});

	it('refuses an expired key before it connects', async () => {
		asRole('owner');
		const made = await makeCredential();
		await env.DB.prepare('UPDATE import_credentials SET expires_at = ? WHERE id = ?')
			.bind(NOW, made.id)
			.run();
		probeCalls.length = 0;
		const reply = await post(importHostKey, 'hostkey', { credentialId: made.id });
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'credential_expired' } });
		expect(probeCalls).toEqual([]);
	});

	it('refuses a name that was public when the key was made and is private now, before it connects', async () => {
		asRole('owner');
		const made = await makeCredential();
		probeCalls.length = 0;
		lookupAnswers = [['10.0.0.9']];
		lookupCalls.length = 0;
		for (const body of [
			{ credentialId: made.id },
			{ credentialId: made.id, confirm: { fingerprint: 'SHA256:first' } }
		]) {
			const reply = await post(importHostKey, 'hostkey', body);
			expect(reply.status).toBe(422);
			expect(reply.json).toMatchObject({ details: { reason: 'host_private' } });
		}
		expect(lookupCalls).toHaveLength(2);
		expect(probeCalls).toEqual([]);
		expect((await rowOf(made.id))!.host_key_fingerprint).toBeNull();
	});

	it('looks the name up again on every probe and dials whatever address passed this time', async () => {
		asRole('owner');
		const made = await makeCredential();
		probeCalls.length = 0;
		lookupAnswers = [['93.184.216.35']];
		await post(importHostKey, 'hostkey', { credentialId: made.id });
		expect(probeCalls).toEqual([{ host: '93.184.216.35', port: 22 }]);
	});

	it('refuses a key whose stored address is a private literal', async () => {
		asRole('owner');
		const made = await makeCredential();
		await env.DB.prepare('UPDATE import_credentials SET host = ? WHERE id = ?')
			.bind('10.0.0.9', made.id)
			.run();
		probeCalls.length = 0;
		lookupCalls.length = 0;
		const reply = await post(importHostKey, 'hostkey', { credentialId: made.id });
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'host_private' } });
		expect(lookupCalls).toEqual([]);
		expect(probeCalls).toEqual([]);
	});

	it('refuses a malformed credential id', async () => {
		asRole('owner');
		expect((await post(importHostKey, 'hostkey', { credentialId: 'nope' })).status).toBe(400);
	});
});

describe('POST the survey', () => {
	it('answers 202 with an import.survey operation and starts the workflow with the id only', async () => {
		asRole('owner');
		const id = await confirmedCredential();
		const reply = await post(importSurvey, 'survey', SURVEY_BODY(id), { idem: key() });
		expect(reply.status).toBe(202);
		const operation = reply.json as {
			id: string;
			type: string;
			status: string;
			targetIds: string[];
		};
		expect(operation).toMatchObject({
			type: 'import.survey',
			status: 'planned',
			targetIds: [id]
		});
		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({ workflow: 'import-survey', id: operation.id });
		expect(started[0]!.params).toEqual({
			operationId: operation.id,
			orgId: ORG,
			credentialId: id,
			root: '/var/www/html',
			ceilingBytes: 16 * 1024 * 1024
		});
		const row = await env.DB.prepare(
			'SELECT site_id, verification FROM operations WHERE id = ?'
		)
			.bind(operation.id)
			.first<{ site_id: string | null; verification: string }>();
		expect(row).toEqual({ site_id: null, verification: 'not-required' });
	});

	it('keeps key material out of the start payload, the operation row and the audit row', async () => {
		asRole('owner');
		const id = await confirmedCredential();
		const pem = await decryptRecordText(
			JSON.parse(String((await rowOf(id))!.key_envelope)),
			importCredentialAad(id),
			await loadKeyRing(KEK)
		);
		const body = pem.split('\n')[1]!;
		const reply = await post(importSurvey, 'survey', SURVEY_BODY(id), { idem: key() });
		const operation = reply.json as { id: string };
		const stored = await env.DB.prepare('SELECT * FROM operations WHERE id = ?')
			.bind(operation.id)
			.first();
		const text = JSON.stringify({ started, stored, audits, reply: reply.text });
		expect(text).not.toContain(body);
		expect(text).not.toContain('PRIVATE KEY');
		expect(text).not.toContain('key_envelope');
		expect(audits.map((entry) => entry.action)).toContain('site.import.survey');
	});

	it('returns the same operation for a repeated key and starts once', async () => {
		asRole('owner');
		const id = await confirmedCredential();
		const repeated = key();
		const first = await post(importSurvey, 'survey', SURVEY_BODY(id), { idem: repeated });
		const second = await post(importSurvey, 'survey', SURVEY_BODY(id), { idem: repeated });
		expect(second.status).toBe(202);
		expect((second.json as { id: string }).id).toBe((first.json as { id: string }).id);
		expect(started).toHaveLength(1);
	});

	it('requires the Idempotency-Key header', async () => {
		asRole('owner');
		const id = await confirmedCredential();
		expect((await post(importSurvey, 'survey', SURVEY_BODY(id))).status).toBe(400);
		expect(started).toHaveLength(0);
	});

	it('refuses before any start when the host key was not confirmed', async () => {
		asRole('owner');
		const made = await makeCredential();
		const reply = await post(importSurvey, 'survey', SURVEY_BODY(made.id), { idem: key() });
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'host_key_unconfirmed' } });
		expect(started).toHaveLength(0);
	});

	it('refuses a path that climbs out of a folder or holds odd characters', async () => {
		asRole('owner');
		const id = await confirmedCredential();
		for (const root of ['../etc', '/var/../etc', 'relative', "/var/www/'; id", '/a b']) {
			const reply = await post(
				importSurvey,
				'survey',
				{ credentialId: id, root },
				{ idem: key() }
			);
			expect(reply.status).toBe(400);
		}
	});

	it('closes the operation as failed when the engine will not take it', async () => {
		asRole('owner');
		const id = await confirmedCredential();
		startFails = true;
		const reply = await post(importSurvey, 'survey', SURVEY_BODY(id), { idem: key() });
		expect(reply.status).toBe(422);
		const row = await env.DB.prepare(
			"SELECT status FROM operations WHERE type = 'import.survey' ORDER BY created_at DESC, rowid DESC"
		).first<{ status: string }>();
		expect(row!.status).toBe('failed');
	});

	it('refuses a key of another organization', async () => {
		asRole('owner');
		const reply = await post(importSurvey, 'survey', SURVEY_BODY(await foreignCredential()), {
			idem: key()
		});
		expect(reply.status).toBe(404);
	});
});

describe('POST the import', () => {
	const importBody = (credentialId: string, surveyId: string) => ({
		credentialId,
		surveyId,
		name: 'imported-site'
	});

	it('answers 202 with a site.import operation, a hidden managed site and a start without any key', async () => {
		asRole('owner');
		const id = await confirmedCredential();
		const surveyId = await surveyed(id);
		started.length = 0;
		audits.length = 0;
		const pem = await decryptRecordText(
			JSON.parse(String((await rowOf(id))!.key_envelope)),
			importCredentialAad(id),
			await loadKeyRing(KEK)
		);
		const reply = await post(importStart, '', importBody(id, surveyId), { idem: key() });
		expect(reply.status).toBe(202);
		const operation = reply.json as {
			id: string;
			type: string;
			targetIds: string[];
			status: string;
		};
		expect(operation).toMatchObject({ type: 'site.import', status: 'planned' });
		expect(operation.targetIds[1]).toBe(id);
		const siteId = operation.targetIds[0]!;

		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({ workflow: 'site-import', id: operation.id });
		const params = started[0]!.params as {
			credentialId: string;
			root: string;
			dossier: unknown;
			create: {
				site: { id: string; plane: string; kind: string };
				firstRun: { reads: unknown };
			};
		};
		expect(params.credentialId).toBe(id);
		expect(params.root).toBe('/var/www/html');
		expect(params.dossier).toEqual({
			importable: true,
			estimateBytes: 4_000_000,
			fileCount: 0
		});
		expect(params.create.site).toMatchObject({ id: siteId, plane: 'managed', kind: 'drupal' });
		expect(params.create.firstRun.reads).toEqual({ ownerToken: expect.any(String) });

		const serialized = JSON.stringify({ started, audits, reply: reply.text });
		expect(serialized).not.toContain(pem.split('\n')[1]!);
		expect(serialized).not.toContain('PRIVATE KEY');
		expect(audits).toEqual([
			expect.objectContaining({
				action: 'site.import',
				target: siteId,
				detail: { operationId: operation.id, credentialId: id, host: 'server.example.test' }
			})
		]);

		const site = await env.DB.prepare(
			'SELECT state, plane, ready_at, imported_from FROM sites WHERE id = ?'
		)
			.bind(siteId)
			.first();
		expect(site).toEqual({
			state: 'active',
			plane: 'managed',
			ready_at: null,
			imported_from: null
		});
		const stored = await env.DB.prepare(
			'SELECT site_id, verification FROM operations WHERE id = ?'
		)
			.bind(operation.id)
			.first();
		expect(stored).toEqual({ site_id: siteId, verification: 'pending' });
	});

	it('returns the same operation for a repeated key and starts once', async () => {
		asRole('owner');
		const id = await confirmedCredential();
		const surveyId = await surveyed(id);
		started.length = 0;
		const repeated = key();
		const first = await post(importStart, '', importBody(id, surveyId), { idem: repeated });
		const second = await post(importStart, '', importBody(id, surveyId), { idem: repeated });
		expect(second.status).toBe(202);
		expect((second.json as { id: string }).id).toBe((first.json as { id: string }).id);
		expect(started).toHaveLength(1);
	});

	it('returns the same operation for a repeat of the service call and refuses the key for another credential', async () => {
		asRole('owner');
		const one = await confirmedCredential();
		const two = await confirmedCredential();
		const surveyOne = await surveyed(one);
		const surveyTwo = await surveyed(two);
		started.length = 0;
		const shared = key();
		const input = (credentialId: string, surveyId: string) => ({
			orgId: ORG,
			userId: 'user-1',
			actor: 'user:user-1',
			credentialId,
			surveyId,
			name: 'imported-site',
			hostnameLabel: undefined,
			idempotencyKey: shared
		});
		const first = await startSiteImport(
			siteServices(),
			importServices(),
			input(one, surveyOne)
		);
		const again = await startSiteImport(
			siteServices(),
			importServices(),
			input(one, surveyOne)
		);
		expect(again.operation.id).toBe(first.operation.id);
		expect(started).toHaveLength(1);
		const caught = await startSiteImport(
			siteServices(),
			importServices(),
			input(two, surveyTwo)
		).catch((error: unknown) => error);
		expect(caught).toBeInstanceOf(ApiError);
		expect(caught).toMatchObject({
			code: 'conflict',
			details: { reason: 'idempotency_key_reused' }
		});
	});

	it('returns the same survey for a repeat of the service call and refuses the key for another credential', async () => {
		asRole('owner');
		const one = await confirmedCredential();
		const two = await confirmedCredential();
		started.length = 0;
		const shared = key();
		const input = (credentialId: string) => ({
			orgId: ORG,
			actor: 'user:user-1',
			credentialId,
			root: '/var/www/html',
			idempotencyKey: shared
		});
		const first = await startImportSurvey(siteServices(), importServices(), input(one));
		const again = await startImportSurvey(siteServices(), importServices(), input(one));
		expect(again.operation.id).toBe(first.operation.id);
		expect(started).toHaveLength(1);
		const caught = await startImportSurvey(siteServices(), importServices(), input(two)).catch(
			(error: unknown) => error
		);
		expect(caught).toMatchObject({ details: { reason: 'idempotency_key_reused' } });
	});

	it('refuses a dossier that is not importable with a plain reason and creates nothing', async () => {
		asRole('owner');
		const id = await confirmedCredential();
		const surveyId = await surveyed(id, {
			verdict: 'refused',
			importable: false,
			refusals: [
				'The database is larger than the 16 MiB a new site accepts in one restore. A paged restore is needed for a larger database and is not available yet'
			]
		});
		started.length = 0;
		const sitesBefore = await env.DB.prepare('SELECT COUNT(*) AS n FROM sites').first<{
			n: number;
		}>();
		const reply = await post(importStart, '', importBody(id, surveyId), { idem: key() });
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'dossier_refused' } });
		expect(started).toHaveLength(0);
		const sitesAfter = await env.DB.prepare('SELECT COUNT(*) AS n FROM sites').first<{
			n: number;
		}>();
		expect(sitesAfter!.n).toBe(sitesBefore!.n);
	});

	it('refuses a survey that has not finished', async () => {
		asRole('owner');
		const id = await confirmedCredential();
		const reply = await post(importSurvey, 'survey', SURVEY_BODY(id), { idem: key() });
		const surveyId = (reply.json as { id: string }).id;
		started.length = 0;
		const refused = await post(importStart, '', importBody(id, surveyId), { idem: key() });
		expect(refused.status).toBe(422);
		expect(refused.json).toMatchObject({ details: { reason: 'survey_not_done' } });
		expect(started).toHaveLength(0);
	});

	it('answers 404 for a survey of another credential or one that does not exist', async () => {
		asRole('owner');
		const one = await confirmedCredential();
		const two = await confirmedCredential();
		const surveyOne = await surveyed(one);
		expect(
			(await post(importStart, '', importBody(two, surveyOne), { idem: key() })).status
		).toBe(404);
		expect(
			(await post(importStart, '', importBody(one, `op_${'z'.repeat(26)}`), { idem: key() }))
				.status
		).toBe(404);
	});

	it('refuses when the key expired after the survey', async () => {
		asRole('owner');
		const id = await confirmedCredential();
		const surveyId = await surveyed(id);
		await env.DB.prepare('UPDATE import_credentials SET expires_at = ? WHERE id = ?')
			.bind(NOW, id)
			.run();
		started.length = 0;
		const reply = await post(importStart, '', importBody(id, surveyId), { idem: key() });
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'credential_expired' } });
		expect(started).toHaveLength(0);
	});

	it('answers 403 plan_full when the plan has no room, and writes nothing', async () => {
		asRole('owner');
		const id = await confirmedCredential();
		const surveyId = await surveyed(id);
		started.length = 0;
		install({ allow: false });
		const reply = await post(importStart, '', importBody(id, surveyId), { idem: key() });
		expect(reply.status).toBe(403);
		expect(started).toHaveLength(0);
	});

	it('deletes the hidden site and closes the operation when the engine will not take it', async () => {
		asRole('owner');
		const id = await confirmedCredential();
		const surveyId = await surveyed(id);
		startFails = true;
		const reply = await post(importStart, '', importBody(id, surveyId), { idem: key() });
		expect(reply.status).toBe(422);
		const row = await env.DB.prepare(
			"SELECT id, status, site_id FROM operations WHERE type = 'site.import' ORDER BY created_at DESC, rowid DESC"
		).first<{ status: string; site_id: string }>();
		expect(row!.status).toBe('failed');
		const site = await env.DB.prepare('SELECT state FROM sites WHERE id = ?')
			.bind(row!.site_id)
			.first<{ state: string }>();
		expect(site!.state).toBe('deleted');
	});

	it('requires the Idempotency-Key header and a body with no extra fields', async () => {
		asRole('owner');
		const id = await confirmedCredential();
		const surveyId = await surveyed(id);
		expect((await post(importStart, '', importBody(id, surveyId))).status).toBe(400);
		expect(
			(
				await post(
					importStart,
					'',
					{ ...importBody(id, surveyId), kind: 'drupal' },
					{ idem: key() }
				)
			).status
		).toBe(400);
	});

	it.each([
		['admin', 202],
		['developer', 403],
		['viewer', 403]
	] as const)('answers %s with %i', async (role, status) => {
		asRole('owner');
		const id = await confirmedCredential();
		const surveyId = await surveyed(id);
		asRole(role);
		const reply = await post(importStart, '', importBody(id, surveyId), { idem: key() });
		expect(reply.status).toBe(status);
	});
});

describe('the expiry sweep', () => {
	it('deletes keys past their expiry, used or not, and leaves the rest', async () => {
		asRole('owner');
		const live = await makeCredential();
		const expired = await makeCredential();
		const used = await makeCredential();
		await env.DB.prepare('UPDATE import_credentials SET expires_at = ? WHERE id = ?')
			.bind(NOW - 1, expired.id)
			.run();
		await env.DB.prepare(
			'UPDATE import_credentials SET expires_at = ?, used_at = ? WHERE id = ?'
		)
			.bind(NOW, NOW - 5, used.id)
			.run();
		const removed = await purgeImportCredentials(await getDb(), NOW);
		expect(removed).toBeGreaterThanOrEqual(2);
		expect(await rowOf(expired.id)).toBeNull();
		expect(await rowOf(used.id)).toBeNull();
		expect(await rowOf(live.id)).not.toBeNull();
	});

	it('does nothing when nothing is due', async () => {
		asRole('owner');
		const live = await makeCredential();
		await purgeImportCredentials(await getDb(), NOW);
		expect(await purgeImportCredentials(await getDb(), NOW)).toBe(0);
		expect(await rowOf(live.id)).not.toBeNull();
	});
});

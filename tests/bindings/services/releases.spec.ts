import { sha256Digest } from '@contracts/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import releaseHook from '../../../src/server/api/hooks/release.post';
import listRoute from '../../../src/server/api/v1/admin/releases/index.get';
import registerRoute from '../../../src/server/api/v1/admin/releases/index.post';
import { applySchema, createCollegeDB, ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import { getRelease } from '../../../src/server/db/repos/releases';
import { hmacSha256Hex } from '../../../src/server/services/crypto';
import { setReleaseServices } from '../../../src/server/services/releases';
import { collegeOnceStore } from '../../../src/server/services/single-use';
import { resetApiDeps } from '../../../src/server/utils/define-api';
import { admin, facts, fresh } from '../../unit/domain/fixtures';
import { asUser, send, setup } from '../../unit/server/fixtures/harness';
import { type Bindings, type OpenBindings, openBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
const getDb = () => ensureCollegeDB(withAtomicBatch(env));

const SECRET = 'release-hook-secret-for-tests-0123456789';
const NOW = Date.now();
const HOOK = '/api/hooks/release';
const URL_OK = 'https://releases.example.test/worker/2.0.0.json';

const manifest = {
	kind: 'worker',
	version: '2.0.0',
	schemaVersion: 2,
	acceptsSchema: 1,
	assets: []
};

let served = new Map<string, string>();
let fetched: string[] = [];
let resolver: (host: string) => Promise<string[]> = async () => ['93.184.216.34'];

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
	await applySchema(createCollegeDB(env));
});

afterAll(() => harness.close());

afterEach(() => {
	resetApiDeps();
	setReleaseServices(null);
});

async function install(hookSecret = SECRET) {
	served = new Map();
	fetched = [];
	resolver = async () => ['93.184.216.34'];
	setReleaseServices({
		getDb,
		once: collegeOnceStore(getDb),
		fetch: async (input) => {
			fetched.push(input);
			const body = served.get(input);
			return body === undefined ? new Response('', { status: 404 }) : new Response(body);
		},
		resolve: (host) => resolver(host),
		now: () => NOW,
		hookSecret
	});
}

async function serve(url: string, doc: unknown) {
	const text = JSON.stringify(doc);
	served.set(url, text);
	return sha256Digest(text);
}

let counter = 0;
async function event(over: Record<string, unknown> = {}, doc: unknown = manifest) {
	const digest = await serve(URL_OK, doc);
	return {
		v: 1,
		id: `evt-${String(++counter).padStart(6, '0')}`,
		type: 'release.published',
		kind: 'worker',
		version: '2.0.0',
		manifestDigest: digest,
		manifestUrl: URL_OK,
		schemaVersion: 2,
		acceptsSchema: 1,
		publishedAt: '2026-11-01T00:00:00.000Z',
		advisoryAt: '2026-10-31T00:00:00.000Z',
		...over
	};
}

async function deliver(body: unknown, signature?: string | null) {
	const raw = JSON.stringify(body);
	const sig = signature === undefined ? `sha256=${await hmacSha256Hex(SECRET, raw)}` : signature;
	return send(releaseHook, HOOK, {
		method: 'POST',
		path: HOOK,
		raw,
		headers: sig === null ? {} : { 'x-drupflare-signature': sig }
	});
}

describe('POST /api/hooks/release', () => {
	it('answers 501 until intake is installed', async () => {
		expect((await deliver(await event())).status).toBe(501);
	});

	it('registers a signed event and stores the advisory time', async () => {
		await install();
		const reply = await deliver(await event({ version: '2.0.0' }));
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({ received: true, duplicate: false, releaseId: '2.0.0' });
		const row = await getRelease(await getDb(), '2.0.0');
		expect(row).toMatchObject({
			kind: 'worker',
			schemaVersion: 2,
			acceptsSchema: 1,
			advisoryAt: Date.parse('2026-10-31T00:00:00.000Z')
		});
	});

	it('refuses a bad or missing signature and fetches nothing', async () => {
		await install();
		const body = await event();
		expect((await deliver(body, 'sha256=00')).status).toBe(401);
		expect((await deliver(body, null)).status).toBe(401);
		expect(fetched).toEqual([]);
	});

	it('answers 501 when no secret is set', async () => {
		await install('');
		expect((await deliver(await event())).status).toBe(501);
	});

	it('answers a replayed event id without fetching again', async () => {
		await install();
		const body = await event({ version: '2.1.0' }, { ...manifest, version: '2.1.0' });
		expect((await deliver(body)).json).toMatchObject({ duplicate: false });
		fetched = [];
		const again = await deliver(body);
		expect(again.status).toBe(200);
		expect(again.json).toMatchObject({ duplicate: true });
		expect(fetched).toEqual([]);
	});

	it('refuses a manifest that does not match its digest, and stores nothing', async () => {
		await install();
		const body = await event({ version: '2.2.0' }, { ...manifest, version: '2.2.0' });
		const reply = await deliver({ ...body, manifestDigest: `sha256:${'a'.repeat(64)}` });
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'digest_mismatch' } });
		expect(await getRelease(await getDb(), '2.2.0')).toBeNull();
	});

	it('refuses an event whose fields disagree with the manifest', async () => {
		await install();
		const body = await event(
			{ version: '2.3.0', schemaVersion: 9 },
			{ ...manifest, version: '2.3.0' }
		);
		const reply = await deliver(body);
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'event_manifest_mismatch' } });
		expect(await getRelease(await getDb(), '2.3.0')).toBeNull();
	});

	it('refuses a manifest that is not a manifest', async () => {
		await install();
		const reply = await deliver(await event({ version: '2.4.0' }, { nope: true }));
		expect(reply.json).toMatchObject({ details: { reason: 'manifest_invalid' } });
	});

	it('refuses an address that resolves to a private network', async () => {
		await install();
		resolver = async () => ['10.0.0.5'];
		const body = await event({ version: '2.5.0' });
		const reply = await deliver(body);
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({
			details: { reason: 'manifest_url_refused', code: 'non_public_address' }
		});
		expect(fetched).toEqual([]);
	});

	it('refuses a manifest the host does not serve', async () => {
		await install();
		const body = await event({
			version: '2.6.0',
			manifestUrl: 'https://releases.example.test/gone.json'
		});
		expect((await deliver(body)).json).toMatchObject({
			details: { reason: 'manifest_unreachable' }
		});
	});

	it('refuses a second manifest under a version that is already registered', async () => {
		await install();
		await deliver(await event({ version: '2.7.0' }, { ...manifest, version: '2.7.0' }));
		const other = await event(
			{ version: '2.7.0', schemaVersion: 3 },
			{ ...manifest, version: '2.7.0', schemaVersion: 3 }
		);
		const reply = await deliver(other);
		expect(reply.status).toBe(409);
		expect(reply.json).toMatchObject({ details: { reason: 'release_changed' } });
	});
});

describe('admin release routes', () => {
	function asAdmin() {
		setup({
			deps: {
				load: async () => ({ resource: {}, facts: facts({ ...admin, ...fresh }) }),
				access: async () => ({ email: 'admin@example.test' })
			}
		});
	}

	it('registers from a manifest address and lists the release', async () => {
		await install();
		asAdmin();
		const digest = await serve(URL_OK, { ...manifest, version: '3.0.0' });
		const made = await send(registerRoute, '/api/v1/admin/releases', {
			method: 'POST',
			path: '/api/v1/admin/releases',
			headers: asUser,
			json: {
				kind: 'worker',
				version: '3.0.0',
				manifestUrl: URL_OK,
				manifestDigest: digest,
				releaseId: 'rel-3'
			}
		});
		expect(made.status).toBe(201);
		expect(made.json).toMatchObject({
			created: true,
			release: { id: 'rel-3', version: '3.0.0' }
		});
		const list = await send(listRoute, '/api/v1/admin/releases', {
			path: '/api/v1/admin/releases?kind=worker',
			headers: asUser
		});
		expect(list.status).toBe(200);
		expect((list.json as { releases: { id: string }[] }).releases.map((r) => r.id)).toContain(
			'rel-3'
		);
	});

	it('refuses a wrong digest', async () => {
		await install();
		asAdmin();
		await serve(URL_OK, { ...manifest, version: '3.1.0' });
		const made = await send(registerRoute, '/api/v1/admin/releases', {
			method: 'POST',
			path: '/api/v1/admin/releases',
			headers: asUser,
			json: {
				kind: 'worker',
				version: '3.1.0',
				manifestUrl: URL_OK,
				manifestDigest: `sha256:${'b'.repeat(64)}`
			}
		});
		expect(made.status).toBe(422);
	});

	it('refuses a user who is not a platform admin', async () => {
		await install();
		setup({
			deps: { load: async () => ({ resource: {}, facts: facts({ ...fresh }) }) }
		});
		const made = await send(registerRoute, '/api/v1/admin/releases', {
			method: 'POST',
			path: '/api/v1/admin/releases',
			headers: asUser,
			json: {
				kind: 'worker',
				version: '3.2.0',
				manifestUrl: URL_OK,
				manifestDigest: `sha256:${'b'.repeat(64)}`
			}
		});
		expect([401, 403, 404]).toContain(made.status);
	});
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import revoke from '../../../../src/server/api/v1/orgs/[orgId]/planes/cloudflare/[id].delete';
import validate from '../../../../src/server/api/v1/orgs/[orgId]/planes/cloudflare/[id]/validate.post';
import list from '../../../../src/server/api/v1/orgs/[orgId]/planes/cloudflare/index.get';
import connect from '../../../../src/server/api/v1/orgs/[orgId]/planes/cloudflare/index.post';
import probe from '../../../../src/server/api/v1/orgs/[orgId]/planes/cloudflare/probe.post';
import { setPlaneConnectionDeps } from '../../../../src/server/services/plane-connections';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { DEPT, facts, fresh, member, ORG, OTHER_ORG } from '../../domain/fixtures';
import { asKey, asUser, send, setup } from '../fixtures/harness';
import { GIVEN, NARROW, world } from '../services/plane-connections-support';

const ROUTE = '/api/v1/orgs/:orgId/planes/cloudflare/probe';
const TOKEN = 'user-token-value-0123456789';
const ACCOUNT = 'a'.repeat(32);

const path = (orgId: string = ORG) => `/api/v1/orgs/${orgId}/planes/cloudflare/probe`;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// the account list answers, and every capability read is refused, so the report has six rows
function stubCloudflare(): void {
	vi.stubGlobal('fetch', async (input: string) => {
		const { pathname } = new URL(String(input));
		if (pathname === '/client/v4/user/tokens/verify') {
			return json({ success: true, result: { id: 'tok_1', status: 'active' } });
		}
		if (pathname === '/client/v4/accounts') {
			return json({ success: true, result: [{ id: ACCOUNT, name: 'Campus Site' }] });
		}
		return json({ success: false }, 403);
	});
}

const call = (json: unknown, headers: Record<string, string> = asUser, orgId: string = ORG) =>
	send(probe, ROUTE, { method: 'POST', path: path(orgId), headers, json });

afterEach(() => {
	resetApiDeps();
	vi.unstubAllGlobals();
});

describe('POST /api/v1/orgs/:orgId/planes/cloudflare/probe', () => {
	it('answers 401 without a session', async () => {
		setup();
		expect((await call({ token: TOKEN }, {})).status).toBe(401);
	});

	it('refuses an API key even when the key holds the scope, and never reaches Cloudflare', async () => {
		const reach = vi.fn(async () => json({ success: false }, 500));
		vi.stubGlobal('fetch', reach);
		setup({
			facts: (input) => ({
				...facts({ ...member('owner'), ...fresh }),
				...(input.principal.kind === 'key'
					? { key: { id: 'key-1', scopes: ['plane.connect'] } }
					: {})
			})
		});
		const reply = await call({ token: TOKEN }, asKey);
		expect(reply.status).toBe(403);
		expect(reach).not.toHaveBeenCalled();
	});

	it('refuses a member who cannot connect a site plane', async () => {
		setup({ role: 'viewer' });
		expect((await call({ token: TOKEN })).status).toBe(403);
	});

	it('answers 404 when the loaded organisation is not the one in the path', async () => {
		setup({
			deps: {
				load: async () => ({
					resource: { orgId: ORG, departmentId: DEPT },
					facts: facts({ ...member('owner'), ...fresh })
				})
			}
		});
		expect((await call({ token: TOKEN }, asUser, OTHER_ORG)).status).toBe(404);
	});

	it('rejects a body without a token', async () => {
		setup();
		const reply = await call({});
		expect(reply.status).toBe(400);
		expect(reply.json).toMatchObject({ code: 'validation' });
	});

	it('rejects a field the body does not allow', async () => {
		setup();
		expect((await call({ token: TOKEN, endpoint: 'https://example.com' })).status).toBe(400);
	});

	it('answers 422 for an account the token cannot see', async () => {
		stubCloudflare();
		setup();
		const reply = await call({ token: TOKEN, accountId: 'c'.repeat(32) });
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ code: 'unprocessable' });
	});

	it('returns the report and never the token', async () => {
		stubCloudflare();
		setup();
		const reply = await call({ token: TOKEN });
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({
			status: 'active',
			kind: 'user',
			tokenId: 'tok_1',
			account: { id: ACCOUNT, name: 'Campus Site' },
			canDownscope: false
		});
		expect((reply.json as { capabilities: unknown[] }).capabilities).toHaveLength(6);
		expect(reply.headers.get('cache-control')).toBe('no-store');
		expect(JSON.stringify(reply.json)).not.toContain(TOKEN);
	});
});

describe('the connection routes', () => {
	const base = '/api/v1/orgs/:orgId/planes/cloudflare';
	const url = (id = '') => `/api/v1/orgs/${ORG}/planes/cloudflare${id === '' ? '' : `/${id}`}`;
	const staleFacts = () => facts(member('owner'));

	const connectCall = (body: unknown, headers: Record<string, string> = asUser) =>
		send(connect, base, { method: 'POST', path: url(), headers, json: body });

	async function connected(over: Parameters<typeof world>[0] = { groupsReadable: false }) {
		const built = await world(over);
		setPlaneConnectionDeps(built.deps);
		setup();
		const reply = await connectCall({ token: GIVEN });
		const id = (reply.json as { connection: { id: string } }).connection.id;
		return { ...built, reply, id };
	}

	afterEach(() => {
		setPlaneConnectionDeps(null);
	});

	it('connects, answers 201 and never returns a token', async () => {
		const { reply } = await connected({});
		expect(reply.status).toBe(201);
		expect(reply.json).toMatchObject({
			connection: { state: 'active', narrowerToken: true, accountName: 'Campus Site' }
		});
		for (const secret of [GIVEN, NARROW]) expect(reply.text).not.toContain(secret);
		expect(Object.keys((reply.json as { connection: object }).connection)).not.toContain(
			'credentialEnvelope'
		);
	});

	it('answers 401 without a session, refuses a key on the writes and lets a scoped key read', async () => {
		const built = await world();
		setPlaneConnectionDeps(built.deps);
		setup({
			facts: (input) => ({
				...facts({ ...member('owner'), ...fresh }),
				...(input.principal.kind === 'key'
					? {
							key: {
								id: 'key-1',
								scopes: ['plane.connect', 'plane.read', 'plane.revoke']
							}
						}
					: {})
			})
		});
		expect((await connectCall({ token: GIVEN }, {})).status).toBe(401);
		expect((await connectCall({ token: GIVEN }, asKey)).status).toBe(403);
		const listed = await send(list, base, { path: url(), headers: asKey });
		expect(listed.status).toBe(200);
		expect(listed.text).not.toContain('credential');
		expect(
			(
				await send(validate, `${base}/:id/validate`, {
					method: 'POST',
					path: url('pcn_x/validate'),
					headers: asKey,
					json: {}
				})
			).status
		).toBe(403);
		expect(
			(
				await send(revoke, `${base}/:id`, {
					method: 'DELETE',
					path: url('pcn_x'),
					headers: asKey
				})
			).status
		).toBe(403);
		expect(built.cf.calls).toEqual([]);
	});

	it('refuses a viewer on connect and revoke', async () => {
		const built = await world();
		setPlaneConnectionDeps(built.deps);
		setup({ role: 'viewer' });
		expect((await connectCall({ token: GIVEN })).status).toBe(403);
		const gone = await send(revoke, `${base}/:id`, {
			method: 'DELETE',
			path: url('pcn_x'),
			headers: asUser
		});
		expect(gone.status).toBe(403);
	});

	it('rejects a body without a token, an extra field and an Idempotency-Key header', async () => {
		const built = await world();
		setPlaneConnectionDeps(built.deps);
		setup();
		expect((await connectCall({})).status).toBe(400);
		expect((await connectCall({ token: GIVEN, extra: 1 })).status).toBe(400);
		const keyed = await connectCall({ token: GIVEN }, { ...asUser, 'idempotency-key': 'k1' });
		expect(keyed.status).toBe(400);
		expect(built.cf.calls).toEqual([]);
	});

	it('answers 409 for a second connect of the same account and 422 for a token without scripts', async () => {
		const { reply } = await connected();
		expect(reply.status).toBe(201);
		const again = await connectCall({ token: GIVEN });
		expect(again.status).toBe(409);
		expect(again.json).toMatchObject({ details: { reason: 'already_connected' } });
		const built = await world({ denied: new Set(['workers/scripts']) });
		setPlaneConnectionDeps(built.deps);
		const refused = await connectCall({ token: GIVEN });
		expect(refused.status).toBe(422);
		expect(refused.json).toMatchObject({ details: { reason: 'scripts_missing' } });
	});

	it('answers 503 when the connection service is not built', async () => {
		setup();
		expect((await connectCall({ token: GIVEN })).status).toBeGreaterThanOrEqual(500);
	});

	it('lists the connections of the organisation and returns no envelope', async () => {
		const { id } = await connected();
		const reply = await send(list, base, { path: url(), headers: asUser });
		expect(reply.status).toBe(200);
		expect(JSON.stringify(reply.json)).toContain(id);
		expect(reply.text).not.toContain('credential');
		expect(reply.headers.get('cache-control')).toBe('no-store');
	});

	it('validates a connection and answers 404 for one that is not there', async () => {
		const { id } = await connected();
		const checked = await send(validate, `${base}/:id/validate`, {
			method: 'POST',
			path: url(`${id}/validate`),
			headers: asUser,
			json: {}
		});
		expect(checked.status).toBe(200);
		expect(checked.json).toMatchObject({ id, state: 'active' });
		const missing = await send(validate, `${base}/:id/validate`, {
			method: 'POST',
			path: url('pcn_none/validate'),
			headers: asUser,
			json: {}
		});
		expect(missing.status).toBe(404);
	});

	it('revokes with a fresh sign-in and refuses a stale one before touching anything', async () => {
		const { id, raw } = await connected();
		setup({ facts: staleFacts });
		const stale = await send(revoke, `${base}/:id`, {
			method: 'DELETE',
			path: url(id),
			headers: asUser
		});
		expect(stale.status).toBeGreaterThanOrEqual(401);
		expect(stale.status).toBeLessThan(500);
		expect(raw.prepare('SELECT state FROM plane_connections').get()).toEqual({
			state: 'active'
		});
		setup();
		const done = await send(revoke, `${base}/:id`, {
			method: 'DELETE',
			path: url(id),
			headers: asUser
		});
		expect(done.status).toBe(200);
		expect(done.json).toMatchObject({
			tokenRemoval: 'not-ours',
			connection: { state: 'revoked' }
		});
		expect(raw.prepare('SELECT credential_envelope FROM plane_connections').get()).toEqual({
			credential_envelope: null
		});
	});

	it('refuses a revoke while a live site uses the account until its id is named', async () => {
		const { id, raw } = await connected();
		raw.prepare(
			`INSERT INTO sites (id, organization_id, name, plane, account_id, state, ready_at, created_at, updated_at)
				VALUES ('site_one', ?, 's', 'self-managed', ?, 'active', 1, 1, 1)`
		).run(ORG, 'a'.repeat(32));
		const refused = await send(revoke, `${base}/:id`, {
			method: 'DELETE',
			path: url(id),
			headers: asUser
		});
		expect(refused.status).toBe(409);
		expect(refused.json).toMatchObject({ details: { reason: 'sites_use_connection' } });
		const forced = await send(revoke, `${base}/:id`, {
			method: 'DELETE',
			path: `${url(id)}?force=site_one`,
			headers: asUser
		});
		expect(forced.status).toBe(200);
	});

	it('writes an audit row for a connect and a revoke', async () => {
		const built = await world({ groupsReadable: false });
		setPlaneConnectionDeps(built.deps);
		const { audits } = setup();
		const reply = await connectCall({ token: GIVEN });
		const id = (reply.json as { connection: { id: string } }).connection.id;
		await send(revoke, `${base}/:id`, { method: 'DELETE', path: url(id), headers: asUser });
		expect(built.audits.map((entry) => entry[1])).toEqual([
			'plane.connection.create',
			'plane.connection.revoke'
		]);
		expect(audits.map((entry) => entry.action)).toEqual(
			expect.arrayContaining(['plane.connect', 'plane.revoke'])
		);
	});
});

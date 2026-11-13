import type { CollegeDBClient } from '@earth-app/collegedb';
import { createApp, createRouter, defineEventHandler, toWebHandler } from 'h3';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../../../../contracts/src/common';
import { claimResponseSchema, hashClaimToken } from '../../../../contracts/src/fleet-link';
import claim from '../../../../src/server/api/v1/nodes/claim.post';
import nodeGet from '../../../../src/server/api/v1/orgs/[orgId]/nodes/[id]/index.get';
import nodeRevoke from '../../../../src/server/api/v1/orgs/[orgId]/nodes/[id]/revoke.post';
import nodesList from '../../../../src/server/api/v1/orgs/[orgId]/nodes/index.get';
import nodePair from '../../../../src/server/api/v1/orgs/[orgId]/nodes/pair.post';
import { SCHEMA_STATEMENTS } from '../../../../src/server/db/schema';
import {
	fleetConfigOf,
	resetFleetServices,
	setFleetServices,
	toNodeView
} from '../../../../src/server/services/fleet';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { ACTION_DEFS, isSessionOnly } from '../../../../src/shared/permissions';
import { FakeNode } from '../../../rigs/fake-node';
import { NOW, ORG, OTHER_ORG, facts, member } from '../../domain/fixtures';
import { asKey, asUser, send, setup } from '../fixtures/harness';

const PAIR = '/api/v1/orgs/:orgId/nodes/pair';
const LIST = '/api/v1/orgs/:orgId/nodes';
const ONE = '/api/v1/orgs/:orgId/nodes/:id';
const REVOKE = '/api/v1/orgs/:orgId/nodes/:id/revoke';
const CLAIM = '/api/v1/nodes/claim';
const DASHBOARD_KEY = 'r2EXtK8adXShcS1LcXu6-pg-dlzFrrSaWFSUBElQY2s';
const LINK = 'wss://link.example';

const base = (orgId: string = ORG) => `/api/v1/orgs/${orgId}/nodes`;

function sqliteDb() {
	const sql = new DatabaseSync(':memory:');
	for (const statement of SCHEMA_STATEMENTS) {
		if (/\b(pairings|nodes)\b/.test(statement)) sql.exec(statement);
	}
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
	return { db, sql };
}

function fleet(over: Partial<Parameters<typeof setFleetServices>[0]> = {}) {
	const clock = { now: NOW };
	const store = sqliteDb();
	const audits: { orgId: string; action: string; actor: string; target: string }[] = [];
	setFleetServices({
		getDb: async () => store.db,
		audit: async (orgId, input) => void audits.push({ orgId, ...input }),
		baseUrl: 'https://app.example',
		linkOrigin: LINK,
		dashboardPublicKey: DASHBOARD_KEY,
		now: () => clock.now,
		...over
	});
	return { ...store, clock, audits };
}

const pairAs = (headers: Record<string, string> = asUser, orgId: string = ORG) =>
	send(nodePair, PAIR, { method: 'POST', path: `${base(orgId)}/pair`, headers, json: {} });

async function pairToken(): Promise<string> {
	const reply = await pairAs();
	return (reply.json as { claimToken: string }).claimToken;
}

async function claimWith(node: FakeNode, token: string) {
	return send(claim, CLAIM, { method: 'POST', path: CLAIM, json: node.claimBody(token) });
}

async function pairedNode(orgId: string = ORG) {
	const node = await FakeNode.create({ now: () => NOW });
	const reply = await send(nodePair, PAIR, {
		method: 'POST',
		path: `${base(orgId)}/pair`,
		headers: asUser,
		json: {}
	});
	const token = (reply.json as { claimToken: string }).claimToken;
	const claimed = await claimWith(node, token);
	return { node, token, nodeId: (claimed.json as { nodeId: string }).nodeId };
}

afterEach(() => {
	resetFleetServices();
	resetApiDeps();
});

describe('node actions', () => {
	it('keeps pairing to a session with a fresh sign-in, and revoking to a fresh sign-in', () => {
		expect(isSessionOnly('node.pair')).toBe(true);
		expect(ACTION_DEFS['node.pair'].stepUp).toBe(true);
		expect(isSessionOnly('node.revoke')).toBe(false);
		expect(ACTION_DEFS['node.revoke'].stepUp).toBe(true);
		expect(ACTION_DEFS['node.read']).not.toHaveProperty('stepUp');
	});
});

describe('POST /api/v1/orgs/:orgId/nodes/pair', () => {
	it('returns the claim token once and stores only its hash', async () => {
		const world = fleet();
		setup();
		const reply = await pairAs();
		expect(reply.status).toBe(201);
		const view = reply.json as {
			pairingId: string;
			claimToken: string;
			pairUrl: string;
			expiresAt: string;
		};
		expect(view.pairUrl).toBe(`https://app.example/p#${view.claimToken}`);
		expect(view.expiresAt).toBe(new Date(NOW + 15 * 60_000).toISOString());
		expect(reply.headers.get('cache-control')).toBe('no-store');
		const rows = world.sql.prepare('SELECT * FROM pairings').all() as Record<string, unknown>[];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			organization_id: ORG,
			state: 'pending',
			created_by: 'user:user-1',
			claim_token_hash: await hashClaimToken(view.claimToken)
		});
		expect(JSON.stringify(rows)).not.toContain(view.claimToken);
	});

	it('writes an audit row for the pairing', async () => {
		fleet();
		const { audits } = setup();
		await pairAs();
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({ action: 'node.pair', via: 'organisation' });
	});

	it.each([
		['owner', 201],
		['admin', 201],
		['developer', 403],
		['billing', 403],
		['viewer', 403]
	] as const)('answers %s with %i', async (role, status) => {
		fleet();
		setup({ role });
		expect((await pairAs()).status).toBe(status);
	});

	it('answers 401 without a session and refuses an API key even with the scope', async () => {
		const world = fleet();
		setup({
			facts: (input) => ({
				...facts({ ...member('owner'), stepUpAt: NOW - 1000 }),
				...(input.principal.kind === 'key'
					? { key: { id: 'key-1', scopes: ['node.pair'] } }
					: {})
			})
		});
		expect((await pairAs({})).status).toBe(401);
		expect((await pairAs(asKey)).status).toBe(403);
		expect(world.sql.prepare('SELECT * FROM pairings').all()).toEqual([]);
	});

	it('asks for a fresh sign-in when the last one is too old', async () => {
		fleet();
		setup({ facts: () => facts({ ...member('owner'), stepUpAt: NOW - 11 * 60_000 }) });
		const reply = await pairAs();
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({ details: { requires: 'step-up' } });
	});

	it('answers 501 until a link host and a dashboard key are set', async () => {
		fleet({ linkOrigin: null });
		setup();
		expect((await pairAs()).status).toBe(501);
		fleet({ dashboardPublicKey: null });
		expect((await pairAs()).status).toBe(501);
	});

	it('answers 404 when the loaded organisation is not the one in the path', async () => {
		fleet();
		setup({
			deps: {
				load: async () => ({
					resource: { orgId: ORG },
					facts: facts({ ...member('owner'), stepUpAt: NOW - 1000 })
				})
			}
		});
		expect((await pairAs(asUser, OTHER_ORG)).status).toBe(404);
	});

	it('refuses an Idempotency-Key, so no reply holding the token is ever stored', async () => {
		const world = fleet();
		setup();
		const reply = await pairAs({ ...asUser, 'idempotency-key': 'key-pair-1' });
		expect(reply.status).toBe(400);
		expect(world.sql.prepare('SELECT * FROM pairings').all()).toEqual([]);
	});

	it('rejects a body with a field it does not know', async () => {
		fleet();
		setup();
		const reply = await send(nodePair, PAIR, {
			method: 'POST',
			path: `${base()}/pair`,
			headers: asUser,
			json: { orgId: OTHER_ORG }
		});
		expect(reply.status).toBe(400);
	});
});

describe('POST /api/v1/nodes/claim', () => {
	it('pins the key and answers with the node id, link address and dashboard key', async () => {
		const world = fleet();
		setup();
		const { node, token, nodeId } = await pairedNode();
		const row = world.sql.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId) as Record<
			string,
			unknown
		>;
		expect(row).toMatchObject({
			organization_id: ORG,
			public_key: node.key.publicKey,
			state: 'active',
			paired_at: NOW,
			last_envelope_seq: -1,
			last_seen_at: null
		});
		expect(JSON.parse(row.host_facts as string)).toMatchObject({
			os: 'linux',
			hostname: 'box-1'
		});
		const pairing = world.sql.prepare('SELECT * FROM pairings').get() as Record<
			string,
			unknown
		>;
		expect(pairing).toMatchObject({ state: 'claimed', claimed_node_id: nodeId });
		expect(token.length).toBeGreaterThanOrEqual(22);
		const again = await claimWith(node, token);
		expect(again.status).toBe(409);
	});

	it('needs no sign-in and returns what the contract names', async () => {
		fleet();
		setup();
		const token = await pairToken();
		const node = await FakeNode.create({ now: () => NOW });
		const reply = await claimWith(node, token);
		expect(reply.status).toBe(201);
		const parsed = claimResponseSchema.parse(reply.json);
		expect(parsed.linkUrl).toBe(`${LINK}/link/${parsed.nodeId}`);
		expect(parsed.dashboardPublicKey).toBe(DASHBOARD_KEY);
		node.adopt(reply.json);
		expect(node.nodeId).toBe(parsed.nodeId);
	});

	it('writes an audit row on the organisation chain', async () => {
		const world = fleet();
		setup();
		await pairedNode();
		expect(world.audits).toHaveLength(1);
		expect(world.audits[0]).toMatchObject({ orgId: ORG, action: 'node.claim' });
		expect(world.audits[0]?.actor).toMatch(/^node:nod_/);
	});

	it('answers 404 for a token that was never issued', async () => {
		fleet();
		setup();
		const node = await FakeNode.create({ now: () => NOW });
		const reply = await claimWith(node, 'A'.repeat(43));
		expect(reply.status).toBe(404);
		expect(reply.json).toMatchObject({ details: { reason: 'invalid_token' } });
	});

	it('answers 409 for a token that has expired, to the millisecond', async () => {
		const world = fleet();
		setup();
		const token = await pairToken();
		const node = await FakeNode.create({ now: () => NOW });
		world.clock.now = NOW + 15 * 60_000 - 1;
		expect((await claimWith(node, token)).status).toBe(201);
		const second = await pairToken();
		world.clock.now = NOW + 30 * 60_000;
		const late = await claimWith(await FakeNode.create({ now: () => NOW }), second);
		expect(late.status).toBe(409);
		expect(late.json).toMatchObject({ details: { reason: 'expired' } });
	});

	it('lets only one of two boxes claim the same token', async () => {
		const world = fleet();
		setup();
		const token = await pairToken();
		const [one, two] = await Promise.all([
			claimWith(await FakeNode.create({ now: () => NOW }), token),
			claimWith(await FakeNode.create({ now: () => NOW }), token)
		]);
		expect([one.status, two.status].sort()).toEqual([201, 409]);
		expect(world.sql.prepare('SELECT * FROM nodes').all()).toHaveLength(1);
	});

	it('refuses a pairing that was revoked', async () => {
		const world = fleet();
		setup();
		const token = await pairToken();
		world.sql.prepare(`UPDATE pairings SET state = 'revoked'`).run();
		const reply = await claimWith(await FakeNode.create({ now: () => NOW }), token);
		expect(reply.status).toBe(409);
		expect(reply.json).toMatchObject({ details: { reason: 'revoked' } });
	});

	it('puts the pairing back when the node row cannot be written, so the box can retry', async () => {
		const world = fleet();
		setup();
		const token = await pairToken();
		world.sql.exec(
			`CREATE TRIGGER nodes_down BEFORE INSERT ON nodes BEGIN SELECT RAISE(ABORT, 'disk full'); END`
		);
		const node = await FakeNode.create({ now: () => NOW });
		expect((await claimWith(node, token)).status).toBe(500);
		expect(world.sql.prepare('SELECT state FROM pairings').get()).toMatchObject({
			state: 'pending'
		});
		world.sql.exec('DROP TRIGGER nodes_down');
		expect((await claimWith(node, token)).status).toBe(201);
	});

	it('answers 409 and releases the pairing when the node already exists', async () => {
		const world = fleet();
		setup();
		const token = await pairToken();
		world.sql.exec(
			`CREATE TRIGGER nodes_dup BEFORE INSERT ON nodes
			 BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: nodes.id'); END`
		);
		const reply = await claimWith(await FakeNode.create({ now: () => NOW }), token);
		expect(reply.status).toBe(409);
		expect(reply.json).toMatchObject({ details: { reason: 'duplicate' } });
		expect(world.sql.prepare('SELECT state FROM pairings').get()).toMatchObject({
			state: 'pending'
		});
	});

	it('rejects a body that is not a claim', async () => {
		fleet();
		setup();
		const node = await FakeNode.create({ now: () => NOW });
		const good = node.claimBody('A'.repeat(43));
		for (const json of [
			{},
			{ ...good, claimToken: 'short' },
			{ ...good, nodePublicKey: 'not-a-key' },
			{ ...good, hostFacts: { os: 'linux' } }
		]) {
			expect((await send(claim, CLAIM, { method: 'POST', path: CLAIM, json })).status).toBe(
				400
			);
		}
	});

	it('answers 501 until a link host and a dashboard key are set', async () => {
		fleet({ linkOrigin: null });
		setup();
		const node = await FakeNode.create({ now: () => NOW });
		expect((await claimWith(node, 'A'.repeat(43))).status).toBe(501);
	});
});

describe('GET /api/v1/orgs/:orgId/nodes', () => {
	it.each([
		['owner', 200],
		['admin', 200],
		['developer', 200],
		['viewer', 200],
		['billing', 403]
	] as const)('answers %s with %i', async (role, status) => {
		fleet();
		setup({ role });
		const reply = await send(nodesList, LIST, { path: base(), headers: asUser });
		expect(reply.status).toBe(status);
	});

	it('lists the nodes of the organisation with their host facts and no key material', async () => {
		fleet();
		setup();
		const { nodeId, node } = await pairedNode();
		const reply = await send(nodesList, LIST, { path: base(), headers: asUser });
		const page = reply.json as { items: Record<string, unknown>[]; nextCursor: string | null };
		expect(page.nextCursor).toBeNull();
		expect(page.items).toEqual([
			{
				id: nodeId,
				state: 'active',
				name: 'box-1',
				os: 'linux',
				arch: 'arm64',
				bastionVersion: '0.1.0',
				workerdVersion: '1.20260101.0',
				mode: 'standalone',
				pairedAt: new Date(NOW).toISOString(),
				lastSeenAt: null,
				revokedAt: null
			}
		]);
		expect(reply.text).not.toContain(node.key.publicKey);
	});

	it('pages in id order and answers 400 for a bad cursor', async () => {
		fleet();
		setup();
		for (let i = 0; i < 3; i++) await pairedNode();
		const first = await send(nodesList, LIST, { path: `${base()}?limit=2`, headers: asUser });
		const one = first.json as { items: { id: string }[]; nextCursor: string };
		expect(one.items).toHaveLength(2);
		const second = await send(nodesList, LIST, {
			path: `${base()}?limit=2&cursor=${one.nextCursor}`,
			headers: asUser
		});
		const two = second.json as { items: { id: string }[]; nextCursor: string | null };
		expect(two.items).toHaveLength(1);
		expect(two.nextCursor).toBeNull();
		const ids = [...one.items, ...two.items].map((item) => item.id);
		expect(ids).toEqual([...ids].sort());
		const bad = await send(nodesList, LIST, { path: `${base()}?cursor=!!`, headers: asUser });
		expect(bad.status).toBe(400);
	});

	it('answers 404 when the loaded organisation is not the one in the path', async () => {
		fleet();
		setup({
			deps: {
				load: async () => ({
					resource: { orgId: ORG },
					facts: facts(member('owner'))
				})
			}
		});
		const reply = await send(nodesList, LIST, { path: base(OTHER_ORG), headers: asUser });
		expect(reply.status).toBe(404);
	});
});

describe('GET /api/v1/orgs/:orgId/nodes/:id', () => {
	it('reads one node and answers 404 for an id the organisation does not hold', async () => {
		fleet();
		setup();
		const { nodeId } = await pairedNode();
		const hit = await send(nodeGet, ONE, { path: `${base()}/${nodeId}`, headers: asUser });
		expect(hit.status).toBe(200);
		expect(hit.json).toMatchObject({ id: nodeId, name: 'box-1' });
		const miss = await send(nodeGet, ONE, {
			path: `${base()}/${newId('nod')}`,
			headers: asUser
		});
		expect(miss.status).toBe(404);
	});

	it('does not show a node that belongs to another organisation', async () => {
		const world = fleet();
		setup();
		const { nodeId } = await pairedNode();
		world.sql.prepare('UPDATE nodes SET organization_id = ?').run(OTHER_ORG);
		const reply = await send(nodeGet, ONE, { path: `${base()}/${nodeId}`, headers: asUser });
		expect(reply.status).toBe(404);
	});

	it('rejects an id that is not a node id and a billing member', async () => {
		fleet();
		setup();
		expect(
			(await send(nodeGet, ONE, { path: `${base()}/site_abc`, headers: asUser })).status
		).toBe(400);
		setup({ role: 'billing' });
		expect(
			(await send(nodeGet, ONE, { path: `${base()}/${newId('nod')}`, headers: asUser }))
				.status
		).toBe(403);
	});

	it('answers 404 when the loaded organisation is not the one in the path', async () => {
		fleet();
		setup({
			deps: {
				load: async () => ({
					resource: { orgId: ORG },
					facts: facts(member('owner'))
				})
			}
		});
		const reply = await send(nodeGet, ONE, {
			path: `${base(OTHER_ORG)}/${newId('nod')}`,
			headers: asUser
		});
		expect(reply.status).toBe(404);
	});
});

describe('POST /api/v1/orgs/:orgId/nodes/:id/revoke', () => {
	const revoke = (nodeId: string, headers: Record<string, string> = asUser) =>
		send(nodeRevoke, REVOKE, {
			method: 'POST',
			path: `${base()}/${nodeId}/revoke`,
			headers,
			json: {}
		});

	it('revokes the node, audits it and leaves a second revoke harmless', async () => {
		const world = fleet();
		const { audits } = setup();
		const { nodeId } = await pairedNode();
		world.clock.now = NOW + 5000;
		const reply = await revoke(nodeId);
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({
			id: nodeId,
			state: 'revoked',
			revokedAt: new Date(NOW + 5000).toISOString()
		});
		world.clock.now = NOW + 9000;
		const again = await revoke(nodeId);
		expect(again.json).toMatchObject({ revokedAt: new Date(NOW + 5000).toISOString() });
		expect(audits.map((entry) => entry.action)).toEqual([
			'node.pair',
			'node.revoke',
			'node.revoke'
		]);
	});

	it('answers 403 for a developer and for a stale sign-in, and 404 for an unknown node', async () => {
		fleet();
		setup();
		const { nodeId } = await pairedNode();
		setup({ role: 'developer' });
		expect((await revoke(nodeId)).status).toBe(403);
		setup({ facts: () => facts({ ...member('owner'), stepUpAt: NOW - 11 * 60_000 }) });
		const stale = await revoke(nodeId);
		expect(stale.status).toBe(403);
		expect(stale.json).toMatchObject({ details: { requires: 'step-up' } });
		setup();
		expect((await revoke(newId('nod'))).status).toBe(404);
	});

	it('cannot revoke a node of another organisation', async () => {
		const world = fleet();
		setup();
		const { nodeId } = await pairedNode();
		world.sql.prepare('UPDATE nodes SET organization_id = ?').run(OTHER_ORG);
		expect((await revoke(nodeId)).status).toBe(404);
		expect(world.sql.prepare('SELECT state FROM nodes').get()).toMatchObject({
			state: 'active'
		});
	});

	it('answers 404 when the loaded organisation is not the one in the path', async () => {
		fleet();
		setup({
			deps: {
				load: async () => ({
					resource: { orgId: ORG },
					facts: facts({ ...member('owner'), stepUpAt: NOW - 1000 })
				})
			}
		});
		const reply = await send(nodeRevoke, REVOKE, {
			method: 'POST',
			path: `${base(OTHER_ORG)}/${newId('nod')}/revoke`,
			headers: asUser,
			json: {}
		});
		expect(reply.status).toBe(404);
	});
});

describe('the node view', () => {
	it('names an unnamed node by the end of its id and leaves unknown facts empty', () => {
		const view = toNodeView({
			id: 'nod_abcdefghijkl',
			orgId: ORG,
			publicKey: 'k',
			hostFacts: {} as never,
			state: 'active',
			pairedAt: NOW,
			lastSeenAt: NOW + 1,
			lastAuditHead: null,
			lastEnvelopeSeq: 2,
			revokedAt: null
		});
		expect(view).toMatchObject({
			name: 'Node ghijkl',
			os: '',
			lastSeenAt: new Date(NOW + 1).toISOString()
		});
	});
});

describe('how a node reaches the link', () => {
	it('loses a WebSocket response in the handler pipeline the dashboard route runs through', async () => {
		const socket = { accept() {}, send() {} };
		const upgrade = Object.assign(new Response(null, { status: 200 }), { webSocket: socket });
		const router = createRouter();
		router.add(
			'/link',
			defineEventHandler(() => upgrade),
			'get'
		);
		const app = createApp();
		app.use(router);
		const out = await toWebHandler(app)(new Request('http://localhost/link'));
		expect(out).not.toBe(upgrade);
		expect((out as unknown as { webSocket?: unknown }).webSocket).toBeUndefined();
	});
});

describe('fleetConfigOf', () => {
	const key = DASHBOARD_KEY;

	it('takes a ws or wss origin and a well formed key, and drops the path', () => {
		expect(
			fleetConfigOf({ FLEET_LINK_ORIGIN: 'wss://link.example/a/b', FLEET_PUBLIC_KEY: key })
		).toEqual({
			linkOrigin: 'wss://link.example',
			dashboardPublicKey: key
		});
		expect(fleetConfigOf({ FLEET_LINK_ORIGIN: 'ws://localhost:8787' }).linkOrigin).toBe(
			'ws://localhost:8787'
		);
	});

	it('leaves pairing unavailable for a value that is missing, empty or wrong, without throwing', () => {
		expect(fleetConfigOf({})).toEqual({ linkOrigin: null, dashboardPublicKey: null });
		expect(fleetConfigOf({ FLEET_LINK_ORIGIN: '', FLEET_PUBLIC_KEY: '' })).toEqual({
			linkOrigin: null,
			dashboardPublicKey: null
		});
		expect(fleetConfigOf({ FLEET_LINK_ORIGIN: 'https://link.example' }).linkOrigin).toBeNull();
		expect(fleetConfigOf({ FLEET_LINK_ORIGIN: 'not a url' }).linkOrigin).toBeNull();
		expect(fleetConfigOf({ FLEET_PUBLIC_KEY: 'short' }).dashboardPublicKey).toBeNull();
		expect(fleetConfigOf({ FLEET_PUBLIC_KEY: 42 }).dashboardPublicKey).toBeNull();
	});
});

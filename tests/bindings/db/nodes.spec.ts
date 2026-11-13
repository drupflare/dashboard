import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1NodeStore } from '../../../engine/src/node-store';
import {
	DuplicateRowError,
	applySchema,
	createCollegeDB,
	ensureCollegeDB
} from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import {
	findPairingByHash,
	getNode,
	insertNode,
	insertPairing,
	listNodes,
	markPairingClaimed,
	releasePairing,
	revokeNode
} from '../../../src/server/db/repos/nodes';
import { createPairing } from '../../../src/server/domain/fleet';
import { type Bindings, type OpenBindings, openBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
let db: ReturnType<typeof createCollegeDB>;

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
	await applySchema(createCollegeDB(env));
	db = await ensureCollegeDB(withAtomicBatch(env));
});

afterAll(() => harness.close());

const ORG = 'org_nodesbind01';
const OTHER = 'org_nodesbind02';
const NODE_ID = 'nod_bind_map0001';
const NOW = 1_790_000_000_000;
const facts = {
	hostname: 'box-1',
	os: 'linux',
	arch: 'arm64',
	bastionVersion: '0.1.0',
	workerdVersion: '1.2',
	mode: 'standalone'
};

let counter = 0;
const nodeId = () => `nod_bind${`${++counter}`.padStart(8, '0')}`;
const node = (id = nodeId(), orgId = ORG) => ({
	id,
	orgId,
	publicKey: 'A'.repeat(43),
	hostFacts: facts,
	now: NOW
});

describe('pairings', () => {
	it('stores a pairing on the directory shard and finds it by token hash', async () => {
		const { pairing } = await createPairing({ orgId: ORG, now: NOW });
		await insertPairing(db, pairing, 'user:u1');
		expect(await findPairingByHash(db, pairing.claimTokenHash)).toEqual(pairing);
		expect(await findPairingByHash(db, `sha256:${'0'.repeat(64)}`)).toBeNull();
	});

	it('refuses a second pairing with the same token hash', async () => {
		const { pairing, token } = await createPairing({ orgId: ORG, now: NOW });
		await insertPairing(db, pairing, 'user:u1');
		const twin = await createPairing({ orgId: ORG, now: NOW, token });
		await expect(insertPairing(db, twin.pairing, 'user:u1')).rejects.toBeInstanceOf(
			DuplicateRowError
		);
	});

	it('lets one claim win, and only inside the expiry', async () => {
		const { pairing } = await createPairing({ orgId: ORG, now: NOW });
		await insertPairing(db, pairing, 'user:u1');
		expect(await markPairingClaimed(db, pairing.id, 'nod_a', pairing.expiresAt)).toBe(false);
		expect(await markPairingClaimed(db, pairing.id, 'nod_a', NOW + 1)).toBe(true);
		expect(await markPairingClaimed(db, pairing.id, 'nod_b', NOW + 2)).toBe(false);
		expect(await findPairingByHash(db, pairing.claimTokenHash)).toMatchObject({
			state: 'claimed',
			claimedNodeId: 'nod_a'
		});
	});

	it('releases a claim only for the node that made it', async () => {
		const { pairing } = await createPairing({ orgId: ORG, now: NOW });
		await insertPairing(db, pairing, 'user:u1');
		await markPairingClaimed(db, pairing.id, 'nod_a', NOW + 1);
		expect(await releasePairing(db, pairing.id, 'nod_other')).toBe(false);
		expect(await releasePairing(db, pairing.id, 'nod_a')).toBe(true);
		expect(await findPairingByHash(db, pairing.claimTokenHash)).toMatchObject({
			state: 'pending',
			claimedNodeId: null
		});
	});
});

describe('nodes', () => {
	it('stores a node and reads it back inside its own organisation only', async () => {
		const fresh = node();
		await insertNode(db, fresh);
		expect(await getNode(db, ORG, fresh.id)).toEqual({
			id: fresh.id,
			orgId: ORG,
			publicKey: fresh.publicKey,
			hostFacts: facts,
			state: 'active',
			pairedAt: NOW,
			lastSeenAt: null,
			lastAuditHead: null,
			lastEnvelopeSeq: -1,
			revokedAt: null
		});
		expect(await getNode(db, OTHER, fresh.id)).toBeNull();
	});

	it('refuses a duplicate node id', async () => {
		const fresh = node();
		await insertNode(db, fresh);
		await expect(insertNode(db, fresh)).rejects.toBeInstanceOf(DuplicateRowError);
	});

	it('lists in id order, by cursor, for one organisation', async () => {
		const org = 'org_nodeslist01';
		const ids = ['nod_list0001', 'nod_list0002', 'nod_list0003'];
		for (const id of ids) await insertNode(db, node(id, org));
		await insertNode(db, node('nod_list0009', 'org_nodeslist02'));
		const first = await listNodes(db, org, { count: 2 });
		expect(first.map((row) => row.id)).toEqual(ids.slice(0, 2));
		const rest = await listNodes(db, org, { after: first[1]!.id, count: 5 });
		expect(rest.map((row) => row.id)).toEqual([ids[2]]);
	});

	it('revokes an active node once and reports a second try as a change of nothing', async () => {
		const fresh = node();
		await insertNode(db, fresh);
		expect(await revokeNode(db, OTHER, fresh.id, NOW + 5)).toBe(false);
		expect(await revokeNode(db, ORG, fresh.id, NOW + 5)).toBe(true);
		expect(await revokeNode(db, ORG, fresh.id, NOW + 9)).toBe(false);
		expect(await getNode(db, ORG, fresh.id)).toMatchObject({
			state: 'revoked',
			revokedAt: NOW + 5
		});
	});
});

describe('the engine node store', () => {
	const store = () => new D1NodeStore(env.DB);

	it('reads the row and answers null for an id it does not hold', async () => {
		const fresh = node();
		await insertNode(db, fresh);
		expect(await store().get(fresh.id)).toMatchObject({ id: fresh.id, orgId: ORG });
		expect(await store().get('nod_missing0001')).toBeNull();
	});

	it('records last seen, the highest seq, new host facts and the audit head', async () => {
		const fresh = node();
		await insertNode(db, fresh);
		const head = { seq: 3, hash: `sha256:${'c'.repeat(64)}` };
		await store().touch(fresh.id, {
			seenAt: NOW + 10,
			seq: 5,
			hostFacts: { ...facts, bastionVersion: '0.2.0' },
			auditHead: head
		});
		await store().touch(fresh.id, { seenAt: NOW + 20, seq: 2 });
		expect(await getNode(db, ORG, fresh.id)).toMatchObject({
			lastSeenAt: NOW + 20,
			lastEnvelopeSeq: 5,
			hostFacts: { bastionVersion: '0.2.0' },
			lastAuditHead: head
		});
	});

	it('leaves a revoked node alone', async () => {
		const fresh = node();
		await insertNode(db, fresh);
		await revokeNode(db, ORG, fresh.id, NOW + 1);
		await store().touch(fresh.id, { seenAt: NOW + 50, seq: 7 });
		expect(await getNode(db, ORG, fresh.id)).toMatchObject({
			lastSeenAt: null,
			lastEnvelopeSeq: -1
		});
	});

	it('lists an organization own live self-hosted sites that hold a hostname, and no one else', async () => {
		const add = (id: string, org: string, plane: string, state: string, host: string | null) =>
			env.DB.prepare(
				`INSERT INTO sites (id, organization_id, name, plane, state, primary_hostname, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			)
				.bind(id, org, id, plane, state, host, NOW, NOW)
				.run();
		await add('site_nodemap0003', ORG, 'self-hosted', 'active', 'three.example.org');
		await add('site_nodemap0001', ORG, 'self-hosted', 'active', 'one.example.org');
		await add('site_nodemap0002', ORG, 'self-hosted', 'suspended', 'two.example.org');
		await add('site_nodemap0004', ORG, 'managed', 'active', 'managed.example.org');
		await add('site_nodemap0005', ORG, 'self-hosted', 'active', null);
		await add('site_nodemap0006', ORG, 'self-hosted', 'deleted', 'gone.example.org');
		await add('site_nodemap0007', ORG, 'self-hosted', 'tombstoned', 'tomb.example.org');
		await add('site_nodemap0008', OTHER, 'self-hosted', 'active', 'other.example.org');
		expect(await store().sites(ORG, NODE_ID)).toEqual([
			{ orgId: ORG, siteId: 'site_nodemap0001', host: 'one.example.org' },
			{ orgId: ORG, siteId: 'site_nodemap0002', host: 'two.example.org' },
			{ orgId: ORG, siteId: 'site_nodemap0003', host: 'three.example.org' }
		]);
		expect(await store().sites(OTHER, NODE_ID)).toEqual([
			{ orgId: OTHER, siteId: 'site_nodemap0008', host: 'other.example.org' }
		]);
		expect(await store().sites('org_nobody0001', NODE_ID)).toEqual([]);
	});

	it('sends a node the sites bound to it, and the unbound sites only when it has none bound', async () => {
		const org = 'org_nodebind0001';
		const insert = (id: string, host: string, nodeId: string | null) =>
			env.DB.prepare(
				`INSERT INTO sites (id, organization_id, name, plane, state, primary_hostname, node_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'self-hosted', 'active', ?, ?, ?, ?)`
			)
				.bind(id, org, id, host, nodeId, NOW, NOW)
				.run();
		await insert('site_bindone0001', 'bound-a.example.org', NODE_ID);
		await insert('site_bindone0002', 'bound-b.example.org', 'nod_nodebind0002');
		await insert('site_bindone0003', 'unbound.example.org', null);
		expect(await store().sites(org, NODE_ID)).toEqual([
			{ orgId: org, siteId: 'site_bindone0001', host: 'bound-a.example.org' }
		]);
		expect(await store().sites(org, 'nod_nodebind0002')).toEqual([
			{ orgId: org, siteId: 'site_bindone0002', host: 'bound-b.example.org' }
		]);
		expect(await store().sites(org, 'nod_nodebind0003')).toEqual([
			{ orgId: org, siteId: 'site_bindone0003', host: 'unbound.example.org' }
		]);
	});

	it('reads a row whose json columns are damaged as empty facts and no head', async () => {
		const fresh = node();
		await insertNode(db, fresh);
		await env.DB.prepare('UPDATE nodes SET host_facts = ?, last_audit_head = ? WHERE id = ?')
			.bind('{broken', '{broken', fresh.id)
			.run();
		expect(await store().get(fresh.id)).toMatchObject({ hostFacts: {}, lastAuditHead: null });
	});
});

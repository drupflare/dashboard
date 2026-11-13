import { describe, expect, it } from 'vitest';
import { generateSigningKey } from '../../../contracts/src/common';
import type { CommandEnvelope } from '../../../contracts/src/fleet-link';
import { D1DomainLedger } from '../../../engine/src/adapters/domains';
import { D1NodeSites } from '../../../engine/src/adapters/nodes';
import { NodeLink, type LinkSocket, type SocketState } from '../../../engine/src/node-link';
import type { NodeRecord, NodeStore } from '../../../engine/src/node-store';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import type { NodeSiteDeps } from '../../../engine/src/ports';
import { PermanentError } from '../../../engine/src/step';
import {
	planNodeSiteCreate,
	readWaitCursor,
	runNodeSiteCreate,
	type NodeRunner,
	type NodeSiteCreateInput
} from '../../../engine/src/workflows/node-site-create';
import { SITE_ADD_TTL_MS } from '../../../src/server/domain/node-site';
import { nodeSiteFailureReason } from '../../../src/shared/operation-copy';
import { FakeNode } from '../../rigs/fake-node';
import { makeRunner, makeWorld, type Memo, type RunnerScript } from './fakes';

const NODE_ID = 'nod_boxtest000001';
const HOST = 'www.example.org';
const OP = `op_${'n'.repeat(26)}`;
const PAYLOAD_URL = 'https://releases.example.org/drupal-1.0.5.tar.gz';
const DIGEST = `sha256:${'ab'.repeat(32)}`;

const MANIFEST = {
	kind: 'drupal-pack',
	version: '1.0.5',
	schemaVersion: 1,
	acceptsSchema: 1,
	assets: [{ name: 'drupal-1.0.5.tar.gz', url: PAYLOAD_URL, digest: DIGEST }]
};

class Socket implements LinkSocket {
	state: SocketState | null = null;
	sent: string[] = [];
	send(text: string) {
		this.sent.push(text);
	}
	close() {}
	readState() {
		return this.state;
	}
	writeState(state: SocketState) {
		this.state = state;
	}
}

type Options = {
	manifest?: unknown;
	release?: 'missing' | 'present';
	orgId?: string;
};

async function box(options: Options = {}) {
	const world = await makeWorld();
	const orgId = options.orgId ?? world.orgId;
	const node = await FakeNode.create({ now: world.clock.now });
	const dashboard = await generateSigningKey();
	node.adopt({
		nodeId: NODE_ID,
		linkUrl: `wss://link.example/link/${NODE_ID}`,
		dashboardPublicKey: dashboard.publicKey
	});
	const record: NodeRecord = {
		id: NODE_ID,
		orgId,
		publicKey: node.key.publicKey,
		hostFacts: node.hostFacts,
		state: 'active',
		pairedAt: world.clock.now() - 1000,
		lastSeenAt: world.clock.now(),
		lastAuditHead: null,
		lastEnvelopeSeq: -1,
		revokedAt: null
	};
	const store: NodeStore = {
		get: async () => record,
		touch: async () => {},
		sites: async () => []
	};
	const memory = new Map<string, unknown>();
	const sockets: Socket[] = [];
	const link = new NodeLink({
		nodes: store,
		storage: {
			get: <T>(key: string) => memory.get(key) as T | undefined,
			put: (key, value) => void memory.set(key, structuredClone(value))
		},
		now: world.clock.now,
		signingKey: async () => dashboard.privateKey,
		sockets: () => sockets,
		nonce: () => new Uint8Array(16).fill(5)
	});
	const socket = new Socket();
	sockets.push(socket);
	link.open(socket, NODE_ID);
	await link.message(socket, await node.answerChallenge(socket.sent[0]!));

	const db = (world.ledger as unknown as { db: import('@cloudflare/workers-types').D1Database })
		.db;
	const releases = {
		manifest: world.deps.releases.manifest,
		part: async (key: string) => {
			if (options.release === 'missing') {
				throw new PermanentError('release_part_missing', `${key} is not published`);
			}
			const manifest = options.manifest === undefined ? MANIFEST : options.manifest;
			return new TextEncoder().encode(JSON.stringify(manifest));
		}
	};
	const deps: NodeSiteDeps = {
		...world.deps,
		releases,
		nodes: {
			node: async () => ({
				id: record.id,
				orgId: record.orgId,
				state: record.state,
				lastSeenAt: record.lastSeenAt
			}),
			send: (id, request) => link.sendCommand(id, request),
			status: async (_id, ref) => link.commandStatus(ref)
		},
		sites: new D1NodeSites(db),
		domains: new D1DomainLedger(db, world.clock.now)
	};
	const commands = async (): Promise<CommandEnvelope[]> => {
		const frames: CommandEnvelope[] = [];
		for (const text of socket.sent.slice(1)) {
			const parsed = JSON.parse(text) as { type?: string };
			if (parsed.type === 'command') frames.push(await node.readCommand(text));
		}
		return frames;
	};
	const answer = async (
		outcome: 'queued' | 'succeeded' | 'failed' | 'rejected',
		code?: string
	) => {
		const [command] = await commands();
		await link.message(
			socket,
			await node.commandResult(command!, outcome, undefined, code ?? null)
		);
	};
	return { world, deps, link, node, record, commands, answer, db };
}

type Box = Awaited<ReturnType<typeof box>>;

function insertHiddenSite(b: Box, siteId: string, host: string, state = 'active') {
	const now = b.world.clock.now();
	b.world.sqlite
		.prepare(
			`INSERT INTO sites (id, organization_id, name, kind, category, plane, config, account_id,
			state, primary_hostname, ready_at, created_at, updated_at)
			VALUES (?, ?, 'Box Site', 'drupal', 'cms', 'self-hosted', 'canonical', NULL, ?, ?, NULL, ?, ?)`
		)
		.run(siteId, b.world.orgId, state, host, now, now);
}

const siteIdOf = (n: string) => `site_${n.repeat(26)}`;

function inputOf(b: Box, patch: Partial<NodeSiteCreateInput> = {}): NodeSiteCreateInput {
	return {
		operationId: OP,
		orgId: b.world.orgId,
		siteId: siteIdOf('b'),
		nodeId: NODE_ID,
		hostname: HOST,
		releaseId: 'v1.0.4',
		...patch
	};
}

async function begin(b: Box, input: NodeSiteCreateInput, hidden = true) {
	if (hidden) insertHiddenSite(b, input.siteId, input.hostname);
	const frozen = await freezePlan(planNodeSiteCreate(input));
	const operation = newOperation({
		id: input.operationId,
		orgId: b.world.orgId,
		idempotencyKey: `key-${input.operationId}`,
		verification: 'not-required',
		frozen,
		now: b.world.clock.now()
	});
	await b.world.store.begin({ operation, accountId: null, siteId: input.siteId });
}

// a runner whose sleep moves the clock and lets the test play the box
function runnerFor(
	b: Box,
	memo: Memo,
	onSleep: (index: number) => Promise<void>,
	script?: RunnerScript
) {
	const { runner, executed } = makeRunner(memo, script);
	let sleeps = 0;
	const node: NodeRunner = {
		do: (name, fn) => runner.do(name, fn),
		sleep: async (_name, ms) => {
			b.world.clock.advance(ms);
			await onSleep(sleeps++);
		}
	};
	return { node, executed };
}

const siteRow = (b: Box, siteId = siteIdOf('b')) =>
	b.world.sqlite
		.prepare('SELECT state, ready_at, node_id, release_id, plane FROM sites WHERE id = ?')
		.get(siteId) as
		| {
				state: string;
				ready_at: number | null;
				node_id: string | null;
				release_id: string | null;
				plane: string;
		  }
		| undefined;

const claimRow = (b: Box) =>
	b.world.sqlite
		.prepare('SELECT site_id, state, operation_id FROM custom_domains WHERE hostname = ?')
		.get(HOST) as { site_id: string; state: string; operation_id: string } | undefined;

const operationOf = async (b: Box, id = OP) => (await b.world.store.get(id))!;

async function runOnce(
	b: Box,
	onSleep: (index: number) => Promise<void>,
	options: {
		memo?: Memo;
		script?: RunnerScript;
		input?: NodeSiteCreateInput;
		fresh?: boolean;
	} = {}
) {
	const input = options.input ?? inputOf(b);
	if (options.fresh !== false) await begin(b, input);
	const { node, executed } = runnerFor(b, options.memo ?? new Map(), onSleep, options.script);
	return { outcome: await runNodeSiteCreate(node, b.deps, input), executed };
}

describe('the plan', () => {
	it('names one site, five steps and no lease', () => {
		const plan = planNodeSiteCreate({ siteId: 'site_a', hostname: HOST });
		expect(plan.type).toBe('node.command');
		expect(plan.targetIds).toEqual(['site_a']);
		expect(plan.steps.map((step) => step.id)).toEqual([
			'claim',
			'payload',
			'add',
			'wait',
			'activate'
		]);
		expect(plan.blastRadius).toEqual({ sites: 1, destructiveSites: 0, productionDeploys: 0 });
	});

	it('reads a cursor only when it is one of its own', () => {
		expect(readWaitCursor(JSON.stringify({ v: 1, startedAt: 5, phase: 'queued' }))).toEqual({
			v: 1,
			startedAt: 5,
			phase: 'queued'
		});
		for (const bad of [
			null,
			'nope',
			'{}',
			JSON.stringify({ v: 2, startedAt: 1, phase: 'sent' })
		]) {
			expect(readWaitCursor(bad)).toBeNull();
		}
	});
});

describe('a create the box approves', () => {
	it('reports the wait while the box holds the command, then lists the site on the node', async () => {
		const b = await box();
		const phases: (string | undefined)[] = [];
		const { outcome } = await runOnce(b, async (index) => {
			const operation = await operationOf(b);
			phases.push(readWaitCursor(operation.cursor)?.phase);
			if (index === 0) await b.answer('queued');
			if (index === 2) await b.answer('succeeded');
		});
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(phases).toEqual(['sent', 'queued', 'queued']);

		const operation = await operationOf(b);
		expect(operation.status).toBe('succeeded');
		expect(operation.steps.map((step) => step.state)).toEqual(Array(5).fill('succeeded'));
		expect(siteRow(b)).toMatchObject({
			state: 'active',
			node_id: NODE_ID,
			release_id: 'v1.0.4',
			plane: 'self-hosted'
		});
		expect(siteRow(b)?.ready_at).not.toBeNull();
		expect(claimRow(b)).toMatchObject({ site_id: siteIdOf('b'), state: 'routed' });
	});

	it('sends one stateful command that carries a host, a url and a checksum and nothing else', async () => {
		const b = await box();
		await runOnce(b, async (index) => {
			if (index === 0) await b.answer('succeeded');
		});
		const sent = await b.commands();
		expect(sent).toHaveLength(1);
		expect(sent[0]!.body).toMatchObject({
			nodeId: NODE_ID,
			opId: OP,
			stepId: 'add',
			idempotencyKey: `${OP}:add`,
			class: 'stateful',
			action: 'site.add',
			params: { host: HOST, bundle: PAYLOAD_URL, checksum: DIGEST }
		});
		expect(Object.keys(sent[0]!.body.params).sort()).toEqual(['bundle', 'checksum', 'host']);
		expect(sent[0]!.body.expiresAt - sent[0]!.ts).toBe(SITE_ADD_TTL_MS);
	});

	it('does not send a second command when the same key is sent again', async () => {
		const b = await box();
		const request = {
			opId: OP,
			stepId: 'add',
			idempotencyKey: `${OP}:add`,
			class: 'stateful' as const,
			action: 'site.add',
			params: { host: HOST, bundle: PAYLOAD_URL, checksum: DIGEST }
		};
		const first = await b.link.sendCommand(NODE_ID, request);
		const again = await b.link.sendCommand(NODE_ID, request);
		expect(first).toMatchObject({ ok: true, added: true });
		expect(again).toMatchObject({ ok: true, added: false });
		expect(await b.commands()).toHaveLength(1);
	});
});

describe('a create that ends without a box site', () => {
	async function refused(outcome: 'failed' | 'rejected', code: string) {
		const b = await box();
		const { outcome: result } = await runOnce(b, async (index) => {
			if (index === 0) await b.answer(outcome, code);
		});
		return { b, result };
	}

	it('closes the operation with a plain reason, retires the row and frees the address', async () => {
		const { b, result } = await refused('failed', 'site_exists');
		expect(result.status).toBe('failed');
		const operation = await operationOf(b);
		expect(operation.status).toBe('failed');
		expect(operation.steps.find((step) => step.id === 'wait')?.state).toBe('failed');
		expect(operation.steps.find((step) => step.id === 'wait')?.error).toContain('site_exists');
		expect(siteRow(b)).toMatchObject({ state: 'deleted', node_id: null });
		expect(siteRow(b)?.ready_at).toBeNull();
		expect(claimRow(b)?.state).toBe('released');
	});

	it('reads an old box refusing the action as a box that needs an update', async () => {
		const { b, result } = await refused('rejected', 'unsupported_action');
		expect(result.status).toBe('failed');
		expect(result).toMatchObject({ reason: expect.stringContaining('box_too_old') });
		expect(nodeSiteFailureReason('box_too_old')).toBe(
			'This box does not support creating sites yet. Update bastion on it, then try again.'
		);
		expect(siteRow(b)?.state).toBe('deleted');
	});

	it.each([
		['rejected', 'rejected_by_operator', 'declined_at_box'],
		['failed', 'no_tenant', 'no_tenant'],
		['failed', 'unknown_tenant', 'unknown_tenant'],
		['failed', 'capacity-exceeded', 'capacity_exceeded'],
		['failed', 'interrupted', 'box_interrupted'],
		['rejected', 'invalid_params', 'box_refused'],
		['failed', 'something-new', 'box_failed']
	] as const)('maps %s with %s to %s', async (outcome, code, mapped) => {
		const { result } = await refused(outcome, code);
		expect(result).toMatchObject({ status: 'failed', reason: expect.stringContaining(mapped) });
	});

	it('fails with not approved when nobody answers before the command expires', async () => {
		const b = await box();
		const { outcome } = await runOnce(b, async (index) => {
			if (index === 0) await b.answer('queued');
		});
		expect(outcome).toMatchObject({
			status: 'failed',
			reason: expect.stringContaining('not_approved')
		});
		expect(nodeSiteFailureReason('not_approved')).toContain('Nobody approved the request');
		expect(siteRow(b)?.state).toBe('deleted');
		expect(claimRow(b)?.state).toBe('released');
	});

	it('sends nothing when the release has no payload for a box', async () => {
		for (const options of [{ release: 'missing' as const }, { manifest: { kind: 'worker' } }]) {
			const b = await box(options);
			const { outcome } = await runOnce(b, async () => {});
			expect(outcome).toMatchObject({
				status: 'failed',
				reason: expect.stringContaining('no_payload')
			});
			expect(await b.commands()).toEqual([]);
			expect(siteRow(b)?.state).toBe('deleted');
		}
	});

	it('refuses a payload whose url or checksum the box would not accept', async () => {
		for (const asset of [
			{ name: 'a.tar.gz', url: 'https://x.example.org/a.tar.gz', digest: 'sha256:abc' },
			{ name: 'a.zip', url: PAYLOAD_URL, digest: DIGEST }
		]) {
			const b = await box({ manifest: { ...MANIFEST, assets: [asset] } });
			const { outcome } = await runOnce(b, async () => {});
			expect(outcome).toMatchObject({ status: 'failed' });
			expect(await b.commands()).toEqual([]);
		}
	});

	it('leaves another site holding the address alone and sends nothing', async () => {
		const b = await box();
		insertHiddenSite(b, siteIdOf('c'), HOST);
		b.world.sqlite
			.prepare(
				`INSERT INTO custom_domains (hostname, organization_id, site_id, operation_id, epoch, state,
				provider_id, ownership_epoch, created_at, updated_at)
				VALUES (?, ?, ?, 'op_other', 1, 'routed', NULL, NULL, 1, 1)`
			)
			.run(HOST, b.world.orgId, siteIdOf('c'));
		const { outcome } = await runOnce(b, async () => {});
		expect(outcome).toMatchObject({
			status: 'failed',
			reason: expect.stringContaining('host_taken')
		});
		expect(await b.commands()).toEqual([]);
		expect(claimRow(b)).toMatchObject({ site_id: siteIdOf('c'), state: 'routed' });
	});

	it('refuses a box that was unpaired or belongs to another organization', async () => {
		const gone = await box();
		gone.record.state = 'revoked';
		const revoked = await runOnce(gone, async () => {});
		expect(revoked.outcome).toMatchObject({ reason: expect.stringContaining('node_revoked') });

		const other = await box({ orgId: `org_${'x'.repeat(26)}` });
		const foreign = await runOnce(other, async () => {});
		expect(foreign.outcome).toMatchObject({
			reason: expect.stringContaining('node_not_found')
		});
		expect(await other.commands()).toEqual([]);
	});

	it('stops waiting when the box is unpaired while the command is held', async () => {
		const b = await box();
		const { outcome } = await runOnce(b, async (index) => {
			if (index === 0) {
				await b.answer('queued');
				b.record.state = 'revoked';
			}
		});
		expect(outcome).toMatchObject({ reason: expect.stringContaining('node_revoked') });
		expect(siteRow(b)?.state).toBe('deleted');
	});

	it('lets a new create of the same address finish what a failed one left on the box', async () => {
		const b = await box();
		await runOnce(b, async (index) => {
			if (index === 0) await b.answer('failed', 'interrupted');
		});
		expect(claimRow(b)?.state).toBe('released');

		const again = inputOf(b, { operationId: `op_${'m'.repeat(26)}`, siteId: siteIdOf('d') });
		const { outcome } = await runOnce(
			b,
			async (index) => {
				const sent = await b.commands();
				if (index === 0) {
					await b.link.message(
						(
							b.link as unknown as { deps: { sockets: () => Socket[] } }
						).deps.sockets()[0]!,
						await b.node.commandResult(sent[1]!, 'succeeded')
					);
				}
			},
			{ input: again }
		);
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(siteRow(b, siteIdOf('d'))).toMatchObject({ node_id: NODE_ID });
		expect(claimRow(b)).toMatchObject({ site_id: siteIdOf('d'), state: 'routed' });
	});
});

describe('a create that is killed and resumed', () => {
	it('sends the command once when it dies after the box took it and before the result was saved', async () => {
		const b = await box();
		const memo: Memo = new Map();
		const first = runOnce(b, async () => {}, { memo, script: { killDuring: 4 } });
		await expect(first).rejects.toMatchObject({ name: 'Killed' });
		expect(await b.commands()).toHaveLength(1);

		const resumed = await runOnce(
			b,
			async (index) => {
				if (index === 0) await b.answer('succeeded');
			},
			{ memo, fresh: false }
		);
		expect(resumed.outcome).toEqual({ status: 'succeeded' });
		expect(await b.commands()).toHaveLength(1);
		expect(siteRow(b)).toMatchObject({ node_id: NODE_ID });
	});

	it('lists the site when it dies after the box added it and before the row was written', async () => {
		const b = await box();
		const memo: Memo = new Map();
		const first = runOnce(
			b,
			async (index) => {
				if (index === 0) await b.answer('succeeded');
			},
			{ memo, script: { killDuring: 9 } }
		);
		await expect(first).rejects.toMatchObject({ name: 'Killed' });
		expect(siteRow(b)?.ready_at).not.toBeNull();

		const resumed = await runOnce(b, async () => {}, { memo, fresh: false });
		expect(resumed.outcome).toEqual({ status: 'succeeded' });
		expect(siteRow(b)).toMatchObject({ state: 'active', node_id: NODE_ID });
		expect(claimRow(b)?.state).toBe('routed');
		expect((await operationOf(b)).status).toBe('succeeded');
	});

	it('sends the command again when the node session lost its record, with the same key', async () => {
		const b = await box();
		let lost = false;
		const original = b.deps.nodes.status;
		b.deps.nodes.status = async (id, ref) => {
			if (!lost) {
				lost = true;
				return { found: false };
			}
			return original(id, ref);
		};
		const { outcome } = await runOnce(b, async (index) => {
			if (index === 1) await b.answer('succeeded');
		});
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(await b.commands()).toHaveLength(1);
	});
});

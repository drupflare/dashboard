import { describe, expect, it } from 'vitest';
import { fromBase64Url, signingKeyFromSeed } from '../../../contracts/src/common';
import {
	ENVELOPE_REFUSALS,
	PAIRING_TTL_MS,
	hashClaimToken,
	newClaimToken,
	serverEnvelopeSchema,
	type NodeEnvelope
} from '../../../contracts/src/fleet-link';
import {
	DEFAULT_COMMAND_TTL_MS,
	MAX_QUEUED_COMMANDS,
	NO_SEQ,
	acceptEnvelope,
	applyResult,
	beginHandshake,
	buildCommand,
	claimDecision,
	commandAllowed,
	commandKey,
	completeHandshake,
	createPairing,
	deliverable,
	enqueue,
	markSent,
	nodeUpdateOf,
	pairingStateAt,
	sameDigest,
	settleExpired,
	signCommand,
	trimRecords,
	type AcceptRefusal,
	type CommandRecord,
	type NodeView
} from '../../../src/server/domain/fleet';
import { FakeNode } from '../../rigs/fake-node';
import { loadVectors } from '../contracts/vectors';

const NOW = 1_790_000_000_000;
const ORG = 'org_fleettest01';

async function pair(now = () => NOW) {
	const node = await FakeNode.create({ now });
	const nodeId = 'nod_fleettest0001';
	node.adopt({
		nodeId,
		linkUrl: `wss://link.example/link/${nodeId}`,
		dashboardPublicKey: node.key.publicKey
	});
	const view: NodeView = {
		id: nodeId,
		orgId: ORG,
		publicKey: node.key.publicKey,
		state: 'active'
	};
	return { node, view };
}

const REQUEST = {
	opId: 'op_fleettestop01',
	stepId: 'apply',
	idempotencyKey: 'key-1',
	class: 'safe' as const,
	action: 'health.observe',
	params: {}
};

describe('pairing', () => {
	it('creates a pending pairing that lasts 15 minutes and keeps only the token hash', async () => {
		const { pairing, token } = await createPairing({ orgId: ORG, now: NOW });
		expect(pairing).toMatchObject({
			orgId: ORG,
			state: 'pending',
			createdAt: NOW,
			expiresAt: NOW + PAIRING_TTL_MS,
			claimedNodeId: null
		});
		expect(pairing.claimTokenHash).toBe(await hashClaimToken(token));
		expect(JSON.stringify(pairing)).not.toContain(token);
		expect(pairing.id).toMatch(/^pair_[0-9a-f]{32}$/);
	});

	it('uses a token and an id the caller supplies', async () => {
		const token = newClaimToken();
		const { pairing } = await createPairing({
			orgId: ORG,
			now: NOW,
			id: 'pair_fixed001',
			token
		});
		expect(pairing.id).toBe('pair_fixed001');
		expect(pairing.claimTokenHash).toBe(await hashClaimToken(token));
	});

	it('reads a pending pairing as expired from the moment its time is up', async () => {
		const { pairing } = await createPairing({ orgId: ORG, now: NOW });
		expect(pairingStateAt(pairing, pairing.expiresAt - 1)).toBe('pending');
		expect(pairingStateAt(pairing, pairing.expiresAt)).toBe('expired');
		expect(pairingStateAt({ ...pairing, state: 'claimed' }, pairing.expiresAt + 1)).toBe(
			'claimed'
		);
		expect(pairingStateAt({ ...pairing, state: 'revoked' }, NOW)).toBe('revoked');
	});

	it('compares digests in full and refuses a different length', () => {
		expect(sameDigest('sha256:abc', 'sha256:abc')).toBe(true);
		expect(sameDigest('sha256:abc', 'sha256:abd')).toBe(false);
		expect(sameDigest('sha256:abc', 'sha256:ab')).toBe(false);
	});

	it('decides a claim for every token state', async () => {
		const { pairing, token } = await createPairing({ orgId: ORG, now: NOW });
		expect(await claimDecision(pairing, token, NOW + 1)).toEqual({ ok: true });
		expect(await claimDecision(null, token, NOW)).toEqual({ ok: false, code: 'invalid_token' });
		expect(await claimDecision(pairing, newClaimToken(), NOW)).toEqual({
			ok: false,
			code: 'invalid_token'
		});
		expect(await claimDecision(pairing, token, pairing.expiresAt)).toEqual({
			ok: false,
			code: 'expired'
		});
		expect(await claimDecision({ ...pairing, state: 'claimed' }, token, NOW)).toEqual({
			ok: false,
			code: 'already_claimed'
		});
		expect(await claimDecision({ ...pairing, state: 'revoked' }, token, NOW)).toEqual({
			ok: false,
			code: 'revoked'
		});
	});
});

describe('acceptEnvelope', () => {
	const seen = new Set<AcceptRefusal>();
	const refusal = (result: { ok: boolean; code?: AcceptRefusal }) => {
		if (!result.ok && result.code) seen.add(result.code);
		return result.ok ? undefined : result.code;
	};

	it('accepts a signed message from the pinned key and carries its seq forward', async () => {
		const { node, view } = await pair();
		const result = await acceptEnvelope(JSON.parse(await node.status()), {
			node: view,
			lastSeq: NO_SEQ,
			now: NOW
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.message).toMatchObject({ type: 'status', seq: 0 });
	});

	it('refuses an unknown node and a revoked node before it reads the message', async () => {
		const { node, view } = await pair();
		const raw = JSON.parse(await node.status());
		expect(refusal(await acceptEnvelope(raw, { node: null, lastSeq: NO_SEQ, now: NOW }))).toBe(
			'unknown_node'
		);
		expect(
			refusal(
				await acceptEnvelope(raw, {
					node: { ...view, state: 'revoked' },
					lastSeq: NO_SEQ,
					now: NOW
				})
			)
		).toBe('node_revoked');
	});

	it('refuses a message that is unsigned, badly signed or signed by another key', async () => {
		const { node, view } = await pair();
		const input = { node: view, lastSeq: NO_SEQ, now: NOW };
		expect(
			refusal(await acceptEnvelope(JSON.parse(await node.status({ unsigned: true })), input))
		).toBe('malformed');
		expect(
			refusal(
				await acceptEnvelope(JSON.parse(await node.status({ badSignature: true })), input)
			)
		).toBe('bad_signature');
		const stranger = await FakeNode.create({ now: () => NOW });
		stranger.adopt({
			nodeId: view.id,
			linkUrl: 'wss://link.example/x',
			dashboardPublicKey: stranger.key.publicKey
		});
		expect(refusal(await acceptEnvelope(JSON.parse(await stranger.status()), input))).toBe(
			'bad_signature'
		);
	});

	it('refuses anything outside the five minute window, on either side', async () => {
		const { node, view } = await pair();
		const input = { node: view, lastSeq: NO_SEQ, now: NOW };
		expect(
			refusal(
				await acceptEnvelope(JSON.parse(await node.status({ skewMs: -301_000 })), input)
			)
		).toBe('expired');
		expect(
			refusal(await acceptEnvelope(JSON.parse(await node.status({ skewMs: 301_000 })), input))
		).toBe('future');
		const edge = await acceptEnvelope(JSON.parse(await node.status({ skewMs: -299_000 })), {
			...input,
			lastSeq: NO_SEQ
		});
		expect(edge.ok).toBe(true);
	});

	it('refuses a seq that did not rise, even when the signature and time are fine', async () => {
		const { node, view } = await pair();
		const first = JSON.parse(await node.status());
		const input = { node: view, now: NOW };
		expect((await acceptEnvelope(first, { ...input, lastSeq: NO_SEQ })).ok).toBe(true);
		expect(refusal(await acceptEnvelope(first, { ...input, lastSeq: first.seq }))).toBe(
			'replayed'
		);
		expect(
			refusal(
				await acceptEnvelope(JSON.parse(await node.status({ seq: 0 })), {
					...input,
					lastSeq: 5
				})
			)
		).toBe('replayed');
		const next = JSON.parse(await node.findings());
		expect((await acceptEnvelope(next, { ...input, lastSeq: first.seq })).ok).toBe(true);
	});

	it('refuses a command sent from the node side and a status naming another node', async () => {
		const { node, view } = await pair();
		const input = { node: view, lastSeq: NO_SEQ, now: NOW };
		const key = await signingKeyFromSeed(new Uint8Array(32).fill(7));
		const command = await signCommand(
			buildCommand(view, REQUEST, { now: NOW, seq: 1, ack: 0 }),
			key.privateKey
		);
		expect(refusal(await acceptEnvelope(command, input))).toBe('wrong_direction');
		const other = await node.status(undefined, { nodeId: 'nod_someoneelse01' as never });
		expect(refusal(await acceptEnvelope(JSON.parse(other), input))).toBe('wrong_node');
		expect(refusal(await acceptEnvelope('not an object', input))).toBe('malformed');
		expect(
			refusal(await acceptEnvelope({ ...JSON.parse(await node.status()), v: 9 }, input))
		).toBe('unsupported_version');
	});

	it('has tripped every refusal the envelope contract can give except those a command carries', () => {
		const commandOnly = ['command_expired'];
		const reachable = ENVELOPE_REFUSALS.filter((code) => !commandOnly.includes(code));
		expect(
			[...seen].filter((code) => (reachable as readonly string[]).includes(code)).sort()
		).toEqual([...reachable].sort());
		expect(seen.has('unknown_node') && seen.has('node_revoked')).toBe(true);
	});
});

describe('what an accepted message changes', () => {
	const message = (type: string, body: unknown, seq = 4) =>
		({
			v: 1,
			id: 'msg_00000001',
			type,
			ts: NOW,
			seq,
			ack: 0,
			body,
			sig: 'x'
		}) as unknown as NodeEnvelope;

	it('records proof of life for every message and host facts for a status', () => {
		expect(nodeUpdateOf(message('findings', { findings: [] }), NOW)).toEqual({
			seenAt: NOW,
			seq: 4
		});
		const status = nodeUpdateOf(
			message('status', {
				nodeId: 'nod_fleettest0001',
				os: 'linux',
				arch: 'x64',
				bastionVersion: '0.2.0',
				workerdVersion: '1.2',
				mode: 'standalone',
				tenants: [],
				sites: [],
				namesHashed: true,
				capacity: {}
			}),
			NOW
		);
		expect(status.hostFacts).toEqual({
			os: 'linux',
			arch: 'x64',
			bastionVersion: '0.2.0',
			workerdVersion: '1.2',
			mode: 'standalone'
		});
		expect(JSON.stringify(status)).not.toContain('tenants');
	});

	it('keeps an optional hostname and records the audit head', () => {
		const withName = nodeUpdateOf(
			message('status', {
				nodeId: 'nod_fleettest0001',
				hostname: 'box-9',
				os: 'linux',
				arch: 'x64',
				bastionVersion: '0.2.0',
				workerdVersion: '1.2',
				mode: 'standalone',
				tenants: [],
				sites: [],
				namesHashed: true,
				capacity: {}
			}),
			NOW
		);
		expect(withName.hostFacts?.hostname).toBe('box-9');
		const head = `sha256:${'a'.repeat(64)}`;
		expect(nodeUpdateOf(message('audit.head', { seq: 7, hash: head }), NOW).auditHead).toEqual({
			seq: 7,
			hash: head
		});
	});
});

describe('handshake', () => {
	it('accepts the node that signs the nonce and settles on the contract version', async () => {
		const { node, view } = await pair();
		const challenge = beginHandshake(NOW);
		const reply = await node.answerChallenge(JSON.stringify(challenge));
		const result = await completeHandshake(JSON.parse(reply), {
			node: view,
			challenge,
			now: NOW
		});
		expect(result).toMatchObject({ ok: true, version: { major: 1, minor: 0 } });
	});

	it('refuses an unknown node, a revoked node and a node id that is not the pinned one', async () => {
		const { node, view } = await pair();
		const challenge = beginHandshake(NOW);
		const reply = JSON.parse(await node.answerChallenge(JSON.stringify(challenge)));
		const run = (target: NodeView | null) =>
			completeHandshake(reply, { node: target, challenge, now: NOW });
		expect(await run(null)).toEqual({ ok: false, code: 'unknown_node' });
		expect(await run({ ...view, state: 'revoked' })).toEqual({
			ok: false,
			code: 'node_revoked'
		});
		expect(await run({ ...view, id: 'nod_fleettest0002' })).toEqual({
			ok: false,
			code: 'wrong_node'
		});
	});

	it('refuses a bad signature, a wrong nonce, a skewed clock and an unsupported version', async () => {
		const { node, view } = await pair();
		const challenge = beginHandshake(NOW);
		const frame = JSON.stringify(challenge);
		const run = async (fault: Parameters<FakeNode['answerChallenge']>[1]) =>
			completeHandshake(JSON.parse(await node.answerChallenge(frame, fault)), {
				node: view,
				challenge,
				now: NOW
			});
		expect(await run({ badSignature: true })).toEqual({ ok: false, code: 'bad_signature' });
		expect(await run({ wrongNonce: true })).toEqual({ ok: false, code: 'wrong_nonce' });
		expect(await run({ skewMs: -301_000 })).toEqual({ ok: false, code: 'expired' });
		expect(await run({ skewMs: 301_000 })).toEqual({ ok: false, code: 'future' });
		expect(await run({ unsupportedRange: true })).toEqual({
			ok: false,
			code: 'unsupported_version'
		});
		expect(await completeHandshake('nope', { node: view, challenge, now: NOW })).toEqual({
			ok: false,
			code: 'malformed'
		});
	});

	it('refuses an answer to a challenge issued more than five minutes ago', async () => {
		const { node, view } = await pair(() => NOW + 400_000);
		const challenge = beginHandshake(NOW);
		const reply = JSON.parse(await node.answerChallenge(JSON.stringify(challenge)));
		expect(
			await completeHandshake(reply, { node: view, challenge, now: NOW + 400_000 })
		).toEqual({
			ok: false,
			code: 'expired'
		});
	});
});

describe('commands', () => {
	it('signs a command the way the contract vector does', async () => {
		const vectors = loadVectors('fleet-link');
		const vector = vectors.positive.find((entry) => entry.name === 'server-command')!;
		const key = await signingKeyFromSeed(fromBase64Url(vectors.keys.dashboard!.seed));
		const view: NodeView = {
			id: vector.input.body.nodeId,
			orgId: ORG,
			publicKey: vectors.keys.node!.publicKey,
			state: 'active'
		};
		const built = buildCommand(
			view,
			{
				opId: vector.input.body.opId,
				stepId: vector.input.body.stepId,
				idempotencyKey: vector.input.body.idempotencyKey,
				class: vector.input.body.class,
				action: vector.input.body.action,
				params: vector.input.body.params,
				ttlMs: 60_000
			},
			{
				now: vector.input.ts,
				seq: vector.input.seq,
				ack: vector.input.ack,
				id: vector.input.id
			}
		);
		const signed = await signCommand(built, key.privateKey);
		expect(signed.sig).toBe(vector.input.sig);
		expect(signed).toEqual(vector.input);
		expect(serverEnvelopeSchema.safeParse(signed).success).toBe(true);
	});

	it('builds an expiry, a local approval default and a fresh id', () => {
		const { view } = {
			view: {
				id: 'nod_fleettest0001',
				orgId: ORG,
				publicKey: 'k',
				state: 'active'
			} as NodeView
		};
		const one = buildCommand(view, REQUEST, { now: NOW, seq: 3, ack: 2 });
		const two = buildCommand(
			view,
			{ ...REQUEST, approval: 'automatic', ttlMs: 1000 },
			{
				now: NOW,
				seq: 4,
				ack: 2
			}
		);
		expect(one.body).toMatchObject({
			nodeId: view.id,
			expiresAt: NOW + DEFAULT_COMMAND_TTL_MS,
			approval: 'local'
		});
		expect(one).toMatchObject({ seq: 3, ack: 2, type: 'command', ts: NOW });
		expect(two.body).toMatchObject({ expiresAt: NOW + 1000, approval: 'automatic' });
		expect(one.id).not.toBe(two.id);
	});

	it('refuses a command to a revoked or unknown node', () => {
		const view: NodeView = {
			id: 'nod_fleettest0001',
			orgId: ORG,
			publicKey: 'k',
			state: 'active'
		};
		expect(commandAllowed(view)).toBeNull();
		expect(commandAllowed({ ...view, state: 'revoked' })).toBe('node_revoked');
		expect(commandAllowed(null)).toBe('unknown_node');
	});

	describe('the queue', () => {
		const view: NodeView = {
			id: 'nod_fleettest0001',
			orgId: ORG,
			publicKey: 'k',
			state: 'active'
		};
		const signer = signingKeyFromSeed(new Uint8Array(32).fill(3));
		const make = async (stepId: string, now = NOW, ttlMs = 60_000) =>
			signCommand(
				buildCommand(view, { ...REQUEST, stepId, ttlMs }, { now, seq: 1, ack: 0 }),
				(await signer).privateKey
			);
		const resultFor = (command: Awaited<ReturnType<typeof make>>, outcome: string) => ({
			opId: command.body.opId,
			stepId: command.body.stepId,
			idempotencyKey: command.body.idempotencyKey,
			outcome: outcome as never,
			code: null,
			deploy: null
		});

		it('queues a command once per operation, step and key', async () => {
			const command = await make('a');
			const first = enqueue([], command, NOW);
			expect(first).toMatchObject({ ok: true, added: true });
			if (!first.ok) return;
			const again = enqueue(first.records, await make('a'), NOW);
			expect(again).toMatchObject({ ok: true, added: false });
			if (again.ok) expect(again.records).toHaveLength(1);
			const other = enqueue(first.records, await make('b'), NOW);
			if (other.ok) expect(other.records).toHaveLength(2);
		});

		it('refuses a command once the open queue is full', async () => {
			let records: CommandRecord[] = [];
			for (let i = 0; i < MAX_QUEUED_COMMANDS; i++) {
				const queued = enqueue(records, await make(`s${i}`), NOW);
				if (queued.ok) records = queued.records;
			}
			expect(enqueue(records, await make('overflow'), NOW)).toEqual({
				ok: false,
				code: 'queue_full'
			});
			const later = enqueue(records, await make('late', NOW + 120_000), NOW + 120_000);
			expect(later.ok).toBe(true);
		});

		it('expires a command by its expiresAt and never delivers it after', async () => {
			const queued = enqueue([], await make('a', NOW, 1000), NOW);
			if (!queued.ok) throw new Error('queue refused');
			expect(deliverable(queued.records, NOW + 999)).toHaveLength(1);
			expect(deliverable(queued.records, NOW + 1000)).toHaveLength(0);
			const settled = settleExpired(queued.records, NOW + 1000);
			expect(settled[0]?.result).toMatchObject({ outcome: 'expired', code: 'expired' });
			expect(settleExpired(settled, NOW + 5000)[0]?.result?.at).toBe(NOW + 1000);
		});

		it('resends a command that was sent and not answered', async () => {
			const queued = enqueue([], await make('a'), NOW);
			if (!queued.ok) throw new Error('queue refused');
			const sent = markSent(queued.records, [queued.record.key], NOW + 1);
			expect(sent[0]?.sentAt).toBe(NOW + 1);
			expect(deliverable(sent, NOW + 2)).toHaveLength(1);
		});

		it('stores a result once and lets a queued report be replaced by the final one', async () => {
			const command = await make('a');
			const queued = enqueue([], command, NOW);
			if (!queued.ok) throw new Error('queue refused');
			const held = applyResult(queued.records, resultFor(command, 'queued'), NOW + 1);
			expect(held.matched).toBe(true);
			expect(deliverable(held.records, NOW + 2)).toHaveLength(0);
			const done = applyResult(held.records, resultFor(command, 'succeeded'), NOW + 2);
			expect(done.records[0]?.result).toMatchObject({ outcome: 'succeeded', at: NOW + 2 });
			const twice = applyResult(done.records, resultFor(command, 'failed'), NOW + 3);
			expect(twice.matched).toBe(false);
			expect(twice.records[0]?.result?.outcome).toBe('succeeded');
		});

		it('drops a result for a command it never sent', async () => {
			const stranger = await make('ghost');
			expect(applyResult([], resultFor(stranger, 'succeeded'), NOW)).toEqual({
				records: [],
				matched: false
			});
		});

		it('keeps open commands and trims the oldest finished ones past the cap', async () => {
			let records: CommandRecord[] = [];
			for (const step of ['a', 'b', 'c', 'd']) {
				const queued = enqueue(records, await make(step), NOW);
				if (queued.ok) records = queued.records;
			}
			records = applyResult(
				records,
				resultFor(records[0]!.envelope, 'succeeded'),
				NOW
			).records;
			records = applyResult(
				records,
				resultFor(records[1]!.envelope, 'succeeded'),
				NOW
			).records;
			const trimmed = trimRecords(records, 3);
			expect(trimmed.map((record) => record.envelope.body.stepId)).toEqual(['b', 'c', 'd']);
			expect(trimRecords(records, 10)).toHaveLength(4);
			expect(commandKey('op_a', 's', 'k')).toBe('op_a|s|k');
		});
	});
});

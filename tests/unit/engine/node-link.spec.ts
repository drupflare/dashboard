import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	generateSigningKey,
	signingKeyFromSeed,
	type SigningKey
} from '../../../contracts/src/common';
import {
	CLOSE,
	HANDSHAKE_MS,
	MAX_REFUSALS,
	NodeLink,
	handleLink,
	linkNodeId,
	type LinkSocket,
	type SocketState
} from '../../../engine/src/node-link';
import type { NodeRecord, NodeStore } from '../../../engine/src/node-store';
import type { NodeUpdate } from '../../../src/server/domain/fleet';
import { type CommandRequest } from '../../../src/server/domain/fleet';
import { FakeNode } from '../../rigs/fake-node';

const START = 1_790_000_000_000;
const NODE_ID = 'nod_linktest00001';

class FakeSocket implements LinkSocket {
	state: SocketState | null = null;
	sent: string[] = [];
	closed: { code: number; reason: string } | null = null;

	send(text: string) {
		if (this.closed) throw new Error('send on a closed socket');
		this.sent.push(text);
	}

	close(code: number, reason: string) {
		this.closed = { code, reason };
	}

	readState() {
		return this.state;
	}

	writeState(state: SocketState) {
		this.state = state;
	}

	frames(): { type?: string; [key: string]: unknown }[] {
		return this.sent.map((text) => JSON.parse(text));
	}
}

class FakeStore implements NodeStore {
	touches: { id: string; update: NodeUpdate }[] = [];
	failTouch = false;

	constructor(public node: NodeRecord | null) {}

	async get() {
		return this.node;
	}

	async touch(id: string, update: NodeUpdate) {
		if (this.failTouch) throw new Error('d1 is down');
		this.touches.push({ id, update });
	}
}

function record(node: FakeNode, over: Partial<NodeRecord> = {}): NodeRecord {
	return {
		id: NODE_ID,
		orgId: 'org_linktest0001',
		publicKey: node.key.publicKey,
		hostFacts: node.hostFacts,
		state: 'active',
		pairedAt: START - 1000,
		lastSeenAt: null,
		lastAuditHead: null,
		lastEnvelopeSeq: -1,
		revokedAt: null,
		...over
	};
}

async function world(over: { dashboard?: SigningKey } = {}) {
	const clock = { now: START };
	const node = await FakeNode.create({ now: () => clock.now });
	const dashboard = over.dashboard ?? (await generateSigningKey());
	node.adopt({
		nodeId: NODE_ID,
		linkUrl: `wss://link.example/link/${NODE_ID}`,
		dashboardPublicKey: dashboard.publicKey
	});
	const store = new FakeStore(record(node));
	const memory = new Map<string, unknown>();
	const sockets: FakeSocket[] = [];
	const link = new NodeLink({
		nodes: store,
		storage: {
			get: <T>(key: string) => memory.get(key) as T | undefined,
			put: (key, value) => void memory.set(key, structuredClone(value))
		},
		now: () => clock.now,
		signingKey: async () => dashboard.privateKey,
		sockets: () => sockets,
		nonce: () => new Uint8Array(16).fill(5)
	});
	const connect = async () => {
		const socket = new FakeSocket();
		sockets.push(socket);
		link.open(socket, NODE_ID);
		await link.message(socket, await node.answerChallenge(socket.sent[0]!));
		return socket;
	};
	return { clock, node, dashboard, store, memory, sockets, link, connect };
}

afterEach(() => vi.restoreAllMocks());

describe('the connection', () => {
	it('sends a challenge on open and a ready frame after the node signs it', async () => {
		const w = await world();
		const socket = await w.connect();
		const [challenge, ready] = socket.frames();
		expect(challenge).toMatchObject({ type: 'challenge', ts: START });
		expect(challenge?.nonce).toBe('BQUFBQUFBQUFBQUFBQUFBQ');
		expect(ready).toEqual({ type: 'ready', version: { major: 1, minor: 0 }, lastSeq: -1 });
		expect(socket.state).toMatchObject({ phase: 'ready', nodeId: NODE_ID });
		expect(socket.closed).toBeNull();
	});

	it('takes status, findings and an audit head and records them on the node row', async () => {
		const w = await world();
		const socket = await w.connect();
		const head = `sha256:${'b'.repeat(64)}`;
		w.clock.now += 1000;
		await w.link.message(socket, await w.node.status());
		await w.link.message(socket, await w.node.findings());
		await w.link.message(socket, await w.node.auditHead(9, head));
		expect(w.store.touches).toHaveLength(3);
		expect(w.store.touches[0]?.update).toMatchObject({
			seenAt: START + 1000,
			seq: 0,
			hostFacts: { os: 'linux', bastionVersion: '0.1.0' }
		});
		expect(w.store.touches[2]?.update.auditHead).toEqual({ seq: 9, hash: head });
		expect(socket.frames().filter((frame) => frame.type === 'refused')).toEqual([]);
	});

	it('tells a node that lost its counter where the server stands', async () => {
		const w = await world();
		const first = await w.connect();
		await w.link.message(first, await w.node.status());
		await w.link.message(first, await w.node.findings());
		const second = await w.connect();
		expect(second.frames().at(-1)).toMatchObject({ type: 'ready', lastSeq: 1 });
		expect(first.closed).toBeNull();
	});

	it('keeps counting from the row when the session storage is empty', async () => {
		const w = await world();
		w.store.node = record(w.node, { lastEnvelopeSeq: 4 });
		const socket = await w.connect();
		expect(socket.frames().at(-1)).toMatchObject({ lastSeq: 4 });
		await w.link.message(socket, await w.node.status({ seq: 4 }));
		expect(socket.frames().at(-1)).toEqual({ type: 'refused', code: 'replayed' });
	});

	it('still accepts the message when the database write fails', async () => {
		const w = await world();
		const socket = await w.connect();
		w.store.failTouch = true;
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		await w.link.message(socket, await w.node.status());
		expect(error).toHaveBeenCalled();
		expect(socket.frames().at(-1)?.type).toBe('ready');
		await w.link.message(socket, await w.node.status({ seq: 0 }));
		expect(socket.frames().at(-1)).toEqual({ type: 'refused', code: 'replayed' });
	});
});

describe('refusals', () => {
	it('refuses a replayed seq and does not touch the row twice', async () => {
		const w = await world();
		const socket = await w.connect();
		const frame = await w.node.status();
		await w.link.message(socket, frame);
		await w.link.message(socket, frame);
		await w.link.message(socket, await w.node.findings(undefined, { replay: true }));
		expect(socket.frames().filter((item) => item.type === 'refused')).toEqual([
			{ type: 'refused', code: 'replayed' },
			{ type: 'refused', code: 'replayed' }
		]);
		expect(w.store.touches).toHaveLength(1);
		expect(socket.closed).toBeNull();
	});

	it('refuses two copies of one frame sent at the same moment', async () => {
		const w = await world();
		const socket = await w.connect();
		const frame = await w.node.status();
		await Promise.all([w.link.message(socket, frame), w.link.message(socket, frame)]);
		expect(w.store.touches).toHaveLength(1);
		expect(socket.frames().filter((item) => item.type === 'refused')).toHaveLength(1);
	});

	it.each([
		['a timestamp from the past', { skewMs: -301_000 }, 'expired'],
		['a timestamp from the future', { skewMs: 301_000 }, 'future'],
		['a bad signature', { badSignature: true as const }, 'bad_signature'],
		['an unsigned message', { unsigned: true as const }, 'malformed']
	])('refuses %s and keeps the connection', async (_name, fault, code) => {
		const w = await world();
		const socket = await w.connect();
		await w.link.message(socket, await w.node.status(fault));
		expect(socket.frames().at(-1)).toEqual({ type: 'refused', code });
		expect(w.store.touches).toEqual([]);
		expect(socket.closed).toBeNull();
	});

	it('refuses text that is not json, and closes on a binary or oversized frame', async () => {
		const w = await world();
		const socket = await w.connect();
		await w.link.message(socket, 'not json');
		expect(socket.frames().at(-1)).toEqual({ type: 'refused', code: 'malformed' });
		await w.link.message(socket, new ArrayBuffer(4));
		expect(socket.closed).toEqual({ code: CLOSE.malformed, reason: 'malformed frame' });
		const big = new FakeSocket();
		w.sockets.push(big);
		w.link.open(big, NODE_ID);
		await w.link.message(big, 'x'.repeat(300_000));
		expect(big.closed?.code).toBe(CLOSE.malformed);
	});

	it('closes a socket that has no state', async () => {
		const w = await world();
		const stray = new FakeSocket();
		await w.link.message(stray, '{}');
		expect(stray.closed?.code).toBe(CLOSE.malformed);
	});

	it('closes after too many refused messages in a row, and a good one resets the count', async () => {
		const w = await world();
		const socket = await w.connect();
		for (let i = 0; i < MAX_REFUSALS; i++) {
			await w.link.message(socket, await w.node.status({ badSignature: true }));
		}
		await w.link.message(socket, await w.node.status());
		expect(socket.state).toMatchObject({ refused: 0 });
		for (let i = 0; i <= MAX_REFUSALS; i++) {
			await w.link.message(socket, await w.node.status({ badSignature: true }));
		}
		expect(socket.closed?.code).toBe(CLOSE.tooManyRefusals);
	});

	it('refuses everything from a node revoked while connected, and closes', async () => {
		const w = await world();
		const socket = await w.connect();
		await w.link.message(socket, await w.node.status());
		w.store.node = record(w.node, { state: 'revoked', revokedAt: START });
		await w.link.message(socket, await w.node.findings());
		expect(socket.frames().at(-1)).toEqual({ type: 'refused', code: 'node_revoked' });
		expect(socket.closed).toEqual({ code: CLOSE.revoked, reason: 'node_revoked' });
		expect(w.store.touches).toHaveLength(1);
	});
});

describe('the handshake', () => {
	async function attempt(
		w: Awaited<ReturnType<typeof world>>,
		fault: Parameters<FakeNode['answerChallenge']>[1] = {}
	) {
		const socket = new FakeSocket();
		w.sockets.push(socket);
		w.link.open(socket, NODE_ID);
		await w.link.message(socket, await w.node.answerChallenge(socket.sent[0]!, fault));
		return socket;
	}

	it('closes on a bad signature, a wrong nonce and a skewed clock', async () => {
		const w = await world();
		for (const [fault, code] of [
			[{ badSignature: true as const }, 'bad_signature'],
			[{ wrongNonce: true as const }, 'wrong_nonce'],
			[{ skewMs: -301_000 }, 'expired'],
			[{ skewMs: 301_000 }, 'future']
		] as const) {
			const socket = await attempt(w, fault);
			expect(socket.closed).toEqual({ code: CLOSE.refused, reason: code });
			expect(socket.frames().at(-1)).toEqual({ type: 'refused', code });
		}
	});

	it('closes with its own code for an unsupported version', async () => {
		const w = await world();
		const socket = await attempt(w, { unsupportedRange: true });
		expect(socket.closed).toEqual({
			code: CLOSE.unsupportedVersion,
			reason: 'unsupported_version'
		});
	});

	it('closes for a revoked node and for one the database does not know', async () => {
		const w = await world();
		w.store.node = record(w.node, { state: 'revoked' });
		expect((await attempt(w)).closed).toEqual({ code: CLOSE.revoked, reason: 'node_revoked' });
		w.store.node = null;
		expect((await attempt(w)).closed).toEqual({ code: CLOSE.revoked, reason: 'unknown_node' });
	});

	it('closes a socket that has not answered within the handshake time', async () => {
		const w = await world();
		const slow = new FakeSocket();
		w.sockets.push(slow);
		w.link.open(slow, NODE_ID);
		expect(w.link.expireHandshakes()).toBe(START + HANDSHAKE_MS);
		expect(slow.closed).toBeNull();
		w.clock.now += HANDSHAKE_MS;
		expect(w.link.expireHandshakes()).toBeNull();
		expect(slow.closed).toEqual({ code: CLOSE.handshakeTimeout, reason: 'handshake timeout' });
		const ready = await w.connect();
		expect(w.link.expireHandshakes()).toBeNull();
		expect(ready.closed).toBeNull();
	});

	it('refuses an answer that is not json', async () => {
		const w = await world();
		const socket = new FakeSocket();
		w.sockets.push(socket);
		w.link.open(socket, NODE_ID);
		await w.link.message(socket, '{{');
		expect(socket.frames().at(-1)).toEqual({ type: 'refused', code: 'malformed' });
		expect(socket.state?.phase).toBe('challenge');
	});
});

describe('commands', () => {
	const request = (over: Partial<CommandRequest> = {}): CommandRequest => ({
		opId: 'op_linktestop01',
		stepId: 'apply',
		idempotencyKey: 'key-1',
		class: 'safe',
		action: 'health.observe',
		params: {},
		...over
	});

	it('queues for an offline node and delivers on connect, signed by the dashboard key', async () => {
		const w = await world();
		const sent = await w.link.sendCommand(NODE_ID, request());
		expect(sent).toMatchObject({ ok: true, delivered: false, added: true });
		const socket = await w.connect();
		const command = await w.node.readCommand(socket.sent.at(-1)!);
		expect(command.body).toMatchObject({ nodeId: NODE_ID, opId: 'op_linktestop01' });
		expect(command.seq).toBe(1);
		expect(w.link.commandStatus(request())).toMatchObject({ found: true, sent: true });
	});

	it('sends at once to a connected node and numbers the commands in order', async () => {
		const w = await world();
		const socket = await w.connect();
		const one = await w.link.sendCommand(NODE_ID, request());
		const two = await w.link.sendCommand(NODE_ID, request({ stepId: 'verify' }));
		expect(one).toMatchObject({ ok: true, delivered: true });
		expect(two).toMatchObject({ ok: true, delivered: true });
		const [first, second] = [
			await w.node.readCommand(socket.sent.at(-2)!),
			await w.node.readCommand(socket.sent.at(-1)!)
		];
		expect([first.seq, second.seq]).toEqual([1, 2]);
	});

	it('treats a repeated operation, step and key as one command', async () => {
		const w = await world();
		const one = await w.link.sendCommand(NODE_ID, request());
		const again = await w.link.sendCommand(NODE_ID, request());
		expect(again).toMatchObject({ ok: true, added: false });
		if (one.ok && again.ok) expect(again.id).toBe(one.id);
		const socket = await w.connect();
		const commands = socket.frames().filter((frame) => frame.type === 'command');
		expect(commands).toHaveLength(1);
	});

	it('stores the result the node returns against the command', async () => {
		const w = await world();
		const socket = await w.connect();
		await w.link.sendCommand(NODE_ID, request());
		const command = await w.node.readCommand(socket.sent.at(-1)!);
		expect(w.link.commandStatus(request())).toMatchObject({ found: true, result: null });
		await w.link.message(socket, await w.node.commandResult(command, 'queued'));
		expect(w.link.commandStatus(request())).toMatchObject({ result: { outcome: 'queued' } });
		await w.link.message(socket, await w.node.commandResult(command, 'succeeded'));
		expect(w.link.commandStatus(request())).toMatchObject({
			result: { outcome: 'succeeded', code: null }
		});
		await w.link.message(socket, await w.node.commandResult(command, 'failed'));
		expect(w.link.commandStatus(request())).toMatchObject({ result: { outcome: 'succeeded' } });
	});

	it('answers found false for a command it never sent', async () => {
		const w = await world();
		expect(w.link.commandStatus(request())).toEqual({ found: false });
	});

	it('ignores a result for a command that was never sent', async () => {
		const w = await world();
		const socket = await w.connect();
		const ghost = await w.link.sendCommand(NODE_ID, request({ stepId: 'ghost' }));
		expect(ghost.ok).toBe(true);
		const command = await w.node.readCommand(socket.sent.at(-1)!);
		const forged = { ...command, body: { ...command.body, stepId: 'other' } };
		await w.link.message(socket, await w.node.commandResult(forged));
		expect(w.link.commandStatus(request({ stepId: 'ghost' }))).toMatchObject({ result: null });
	});

	it('does not deliver a command after its expiry and reports it expired', async () => {
		const w = await world();
		await w.link.sendCommand(NODE_ID, request({ ttlMs: 1000 }));
		w.clock.now += 1000;
		const socket = await w.connect();
		expect(socket.frames().some((frame) => frame.type === 'command')).toBe(false);
		expect(w.link.commandStatus(request())).toMatchObject({
			result: { outcome: 'expired', code: 'expired' }
		});
	});

	it('refuses a command to a revoked node and to an unknown node, and signs nothing', async () => {
		const w = await world();
		w.store.node = record(w.node, { state: 'revoked' });
		expect(await w.link.sendCommand(NODE_ID, request())).toEqual({
			ok: false,
			code: 'node_revoked'
		});
		w.store.node = null;
		expect(await w.link.sendCommand(NODE_ID, request())).toEqual({
			ok: false,
			code: 'unknown_node'
		});
		expect(w.memory.get('commands')).toBeUndefined();
		expect(w.memory.get('outSeq')).toBeUndefined();
	});

	it('refuses when the queue is full', async () => {
		const w = await world();
		for (let i = 0; i < 100; i++) {
			await w.link.sendCommand(NODE_ID, request({ stepId: `s${i}` }));
		}
		expect(await w.link.sendCommand(NODE_ID, request({ stepId: 'more' }))).toEqual({
			ok: false,
			code: 'queue_full'
		});
		expect(w.memory.get('outSeq')).toBe(100);
	});

	it('refuses a command signed with a different key than the one the node pinned', async () => {
		const w = await world();
		const rogue = await signingKeyFromSeed(new Uint8Array(32).fill(9));
		const other = await world({ dashboard: rogue });
		await other.link.sendCommand(NODE_ID, request());
		const socket = await other.connect();
		await expect(w.node.readCommand(socket.sent.at(-1)!)).rejects.toThrow('bad_signature');
	});
});

describe('handleLink', () => {
	const url = `https://engine/link/${NODE_ID}`;
	const upgrade = { headers: { upgrade: 'websocket' } };

	function route(node: NodeRecord | null) {
		const forwarded: string[] = [];
		const looked: string[] = [];
		return {
			forwarded,
			looked,
			deps: {
				nodes: {
					get: async (id: string) => {
						looked.push(id);
						return node;
					},
					touch: async () => undefined
				} satisfies NodeStore,
				sessions: {
					get: (id: string) => ({
						fetch: async (req: Request) => {
							forwarded.push(`${id} ${req.url}`);
							return new Response('session', { status: 200 });
						}
					})
				}
			}
		};
	}

	const active = (): NodeRecord => ({
		id: NODE_ID,
		orgId: 'org_linktest0001',
		publicKey: 'k',
		hostFacts: {} as never,
		state: 'active',
		pairedAt: START,
		lastSeenAt: null,
		lastAuditHead: null,
		lastEnvelopeSeq: -1,
		revokedAt: null
	});

	it('finds the node id in a link path and nothing else', () => {
		expect(linkNodeId(new URL(url))).toBe(NODE_ID);
		expect(linkNodeId(new URL('https://engine/start'))).toBeNull();
		expect(linkNodeId(new URL(`https://engine/link/${NODE_ID}/extra`))).toBeNull();
		expect(linkNodeId(new URL('https://engine/link/abc'))).toBeNull();
	});

	it('hands an upgrade for an active node to its session', async () => {
		const r = route(active());
		const response = await handleLink(new Request(url, upgrade), r.deps);
		expect(response.status).toBe(200);
		expect(r.forwarded).toEqual([`${NODE_ID} ${url}`]);
	});

	it('answers 426 without an upgrade header and never reaches the session', async () => {
		const r = route(active());
		const response = await handleLink(new Request(url), r.deps);
		expect(response.status).toBe(426);
		expect(r.forwarded).toEqual([]);
		expect(r.looked).toEqual([]);
	});

	it('answers 404 for a node the database does not know and 403 for a revoked one', async () => {
		const missing = route(null);
		expect((await handleLink(new Request(url, upgrade), missing.deps)).status).toBe(404);
		const revoked = route({ ...active(), state: 'revoked' });
		const reply = await handleLink(new Request(url, upgrade), revoked.deps);
		expect(reply.status).toBe(403);
		expect(await reply.json()).toEqual({ ok: false, code: 'node_revoked' });
		expect([...missing.forwarded, ...revoked.forwarded]).toEqual([]);
	});

	it('answers 404 for a path that is not a link path', async () => {
		const r = route(active());
		expect(
			(await handleLink(new Request('https://engine/other', upgrade), r.deps)).status
		).toBe(404);
	});
});

// #region the Durable Object shell

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		constructor(
			readonly ctx: unknown,
			readonly env: unknown
		) {}
	}
}));

describe('NodeSession', () => {
	class SpySocket {
		attachment: unknown = null;
		sent: string[] = [];
		closed: [number, string?][] = [];
		send(text: string) {
			this.sent.push(text);
		}
		close(code: number, reason?: string) {
			this.closed.push([code, reason]);
		}
		serializeAttachment(value: unknown) {
			this.attachment = value;
		}
		deserializeAttachment() {
			return this.attachment;
		}
	}

	async function shell() {
		// a computed specifier keeps the workers-typed engine source out of the unit typecheck
		const sessionModule = '../../../engine/src/node-session';
		const { NodeSession } = (await import(/* @vite-ignore */ sessionModule)) as {
			NodeSession: new (
				ctx: never,
				env: never
			) => {
				fetch(request: Request): Promise<Response>;
				webSocketMessage(ws: unknown, message: string | ArrayBuffer): Promise<void>;
				webSocketClose(ws: unknown): void;
				alarm(): Promise<void>;
				sendCommand(nodeId: string, request: CommandRequest): Promise<unknown>;
				commandStatus(ref: {
					opId: string;
					stepId: string;
					idempotencyKey: string;
				}): unknown;
			};
		};
		const dashboard = await generateSigningKey();
		const seed = new Uint8Array(32).fill(4);
		const node = await FakeNode.create({ now: () => Date.now() });
		node.adopt({
			nodeId: NODE_ID,
			linkUrl: 'wss://link.example/x',
			dashboardPublicKey: dashboard.publicKey
		});
		const row = {
			id: NODE_ID,
			organization_id: 'org_linktest0001',
			public_key: node.key.publicKey,
			host_facts: JSON.stringify(node.hostFacts),
			state: 'active',
			paired_at: START,
			last_seen_at: null,
			last_audit_head: null,
			last_envelope_seq: -1,
			revoked_at: null
		};
		const kv = new Map<string, unknown>();
		const open: SpySocket[] = [];
		const accepted: SpySocket[] = [];
		const alarms: number[] = [];
		const ctx = {
			storage: {
				kv: {
					get: (key: string) => kv.get(key),
					put: (key: string, value: unknown) => void kv.set(key, structuredClone(value))
				},
				setAlarm: async (at: number) => void alarms.push(at)
			},
			getWebSockets: () => open,
			acceptWebSocket: (socket: SpySocket) => {
				accepted.push(socket);
				open.push(socket);
			}
		};
		const env = {
			DB: {
				prepare: () => ({ bind: () => ({ first: async () => row, run: async () => ({}) }) })
			},
			FLEET_SEED: Buffer.from(seed).toString('base64url')
		};
		const session = new NodeSession(ctx as never, env as never);
		return { session, node, ctx, open, accepted, alarms, seed };
	}

	const upgradeRequest = (
		path = `/link/${NODE_ID}`,
		headers: Record<string, string> = { upgrade: 'websocket' }
	) => new Request(`https://engine${path}`, { headers });

	it('answers 400 for a request that is not a link upgrade', async () => {
		const { session } = await shell();
		expect((await session.fetch(upgradeRequest(`/link/${NODE_ID}`, {}))).status).toBe(400);
		expect((await session.fetch(upgradeRequest('/other'))).status).toBe(400);
	});

	it('accepts the upgrade, replaces the old socket and sends the challenge', async () => {
		const { session, accepted, open, alarms } = await shell();
		const earlier = new SpySocket();
		open.push(earlier);
		const server = new SpySocket();
		const client = {};
		vi.stubGlobal(
			'WebSocketPair',
			class {
				0 = client;
				1 = server;
			}
		);
		vi.stubGlobal(
			'Response',
			class {
				status: number;
				webSocket: unknown;
				constructor(_body: unknown, init: { status: number; webSocket: unknown }) {
					this.status = init.status;
					this.webSocket = init.webSocket;
				}
			}
		);
		try {
			const response = (await session.fetch(upgradeRequest())) as unknown as {
				status: number;
				webSocket: unknown;
			};
			expect(response.status).toBe(101);
			expect(response.webSocket).toBe(client);
		} finally {
			vi.unstubAllGlobals();
		}
		expect(earlier.closed).toEqual([[CLOSE.replaced, 'replaced']]);
		expect(accepted).toEqual([server]);
		expect(JSON.parse(server.sent[0]!)).toMatchObject({ type: 'challenge' });
		expect(server.attachment).toMatchObject({ phase: 'challenge', nodeId: NODE_ID });
		expect(alarms[0]).toBeGreaterThan(Date.now());
	});

	it('runs the handshake, closes an idle challenge on the alarm and closes cleanly on close', async () => {
		const { session, node, open, alarms } = await shell();
		const socket = new SpySocket();
		open.push(socket);
		(session as unknown as { link(): { open(s: unknown, id: string): void } }).link().open(
			{
				send: (t: string) => socket.send(t),
				close: (c: number, r: string) => socket.close(c, r),
				readState: () => socket.attachment,
				writeState: (s: unknown) => socket.serializeAttachment(s)
			},
			NODE_ID
		);
		await session.webSocketMessage(
			socket as never,
			await node.answerChallenge(socket.sent[0]!)
		);
		expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ type: 'ready' });
		await session.alarm();
		expect(alarms).toEqual([]);
		session.webSocketClose(socket as never);
		expect(socket.closed.at(-1)).toEqual([1000, 'closed']);
	});

	it('queues a command through the session and reports its status', async () => {
		const { session } = await shell();
		const request = {
			opId: 'op_linktestop01',
			stepId: 'apply',
			idempotencyKey: 'k1',
			class: 'safe' as const,
			action: 'health.observe',
			params: {}
		};
		expect(await session.sendCommand(NODE_ID, request)).toMatchObject({
			ok: true,
			delivered: false
		});
		expect(session.commandStatus(request)).toMatchObject({ found: true, sent: false });
	});
});

// #endregion

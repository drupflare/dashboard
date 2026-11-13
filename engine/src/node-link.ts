import type { Challenge, NodeEnvelope } from '@contracts/fleet-link';
import { frameDigest, reconcileBoxSites, tokensFor } from '../../src/server/domain/box-sites';
import {
	NO_SEQ,
	acceptEnvelope,
	applyResult,
	beginHandshake,
	buildCommand,
	buildSites,
	commandAllowed,
	commandKey,
	completeHandshake,
	deliverable,
	enqueue,
	markSent,
	nodeUpdateOf,
	settleExpired,
	signCommand,
	signSites,
	siteMapOf,
	sitesDigest,
	sitesFrameAllowed,
	trimRecords,
	type CommandRecord,
	type CommandRefusal,
	type CommandRequest
} from '../../src/server/domain/fleet';
import type { BoxSiteStore } from './box-site-store';
import type { NodeRecord, NodeStore } from './node-store';

export const LINK_PATH = /^\/link\/(nod_[0-9a-z]{8,40})$/;
export const HANDSHAKE_MS = 30_000;
export const MAX_FRAME_CHARS = 256 * 1024;
export const MAX_REFUSALS = 5;
export const SITES_SYNC_MS = 60_000;
// a status frame that lists the same sites as the last one is read again only this often
export const SITE_NAMES_RECHECK_MS = 60 * 60_000;

// private-use close codes; a node reads the code and the reason text
export const CLOSE = {
	malformed: 4400,
	refused: 4401,
	revoked: 4403,
	handshakeTimeout: 4408,
	replaced: 4409,
	unsupportedVersion: 4426,
	tooManyRefusals: 4429
} as const;

export type SocketState =
	| { phase: 'challenge'; nodeId: string; challenge: Challenge; refused: number }
	| {
			phase: 'ready';
			nodeId: string;
			refused: number;
			version: { major: number; minor: number };
			// digest of the site map this connection last received
			sitesDigest?: string;
	  };

export interface LinkSocket {
	send(text: string): void;
	close(code: number, reason: string): void;
	readState(): SocketState | null;
	writeState(state: SocketState): void;
}

export interface LinkStorage {
	get<T>(key: string): T | undefined;
	put(key: string, value: unknown): void;
}

export interface LinkDeps {
	nodes: NodeStore;
	// without it a status frame's site list is not compared with the dashboard's rows
	boxSites?: BoxSiteStore;
	storage: LinkStorage;
	now: () => number;
	signingKey: () => Promise<CryptoKey>;
	sockets: () => LinkSocket[];
	nonce?: () => Uint8Array;
}

export type SendResult =
	| { ok: true; id: string; delivered: boolean; added: boolean }
	| { ok: false; code: CommandRefusal };

export type CommandStatus =
	{ found: false } | { found: true; sent: boolean; result: CommandRecord['result'] };

const RECORDS = 'commands';
const OUT_SEQ = 'outSeq';
const IN_SEQ = 'seq';
const SITE_NAMES = 'siteNames';

type StatusBody = Extract<NodeEnvelope, { type: 'status' }>['body'];

const frame = (value: unknown): string => JSON.stringify(value);

export function linkNodeId(url: URL): string | null {
	return LINK_PATH.exec(url.pathname)?.[1] ?? null;
}

// a node session's decisions with every effect behind a port, so a fake socket and an in-memory
// store drive it the way the Durable Object does
export class NodeLink {
	private tail: Promise<unknown> = Promise.resolve();

	constructor(private readonly deps: LinkDeps) {}

	// events can interleave at an await, so two copies of one frame would both pass the seq check
	// without this
	private serial<T>(run: () => Promise<T>): Promise<T> {
		const next = this.tail.then(run, run);
		this.tail = next.catch(() => undefined);
		return next;
	}

	private records(): CommandRecord[] {
		return this.deps.storage.get<CommandRecord[]>(RECORDS) ?? [];
	}

	private saveRecords(records: readonly CommandRecord[]): void {
		this.deps.storage.put(RECORDS, trimRecords(records));
	}

	open(socket: LinkSocket, nodeId: string): void {
		const challenge = beginHandshake(this.deps.now(), this.deps.nonce?.());
		socket.writeState({ phase: 'challenge', nodeId, challenge, refused: 0 });
		socket.send(frame({ type: 'challenge', ...challenge }));
	}

	private async refuse(
		socket: LinkSocket,
		state: SocketState,
		code: string,
		close?: { code: number; reason: string }
	): Promise<void> {
		socket.send(frame({ type: 'refused', code }));
		if (close) {
			socket.close(close.code, close.reason);
			return;
		}
		const refused = state.refused + 1;
		if (refused > MAX_REFUSALS) {
			socket.close(CLOSE.tooManyRefusals, 'too many refused messages');
			return;
		}
		socket.writeState({ ...state, refused });
	}

	message(socket: LinkSocket, data: string | ArrayBuffer): Promise<void> {
		return this.serial(() => this.handle(socket, data));
	}

	private async handle(socket: LinkSocket, data: string | ArrayBuffer): Promise<void> {
		const state = socket.readState();
		if (state === null || typeof data !== 'string' || data.length > MAX_FRAME_CHARS) {
			socket.close(CLOSE.malformed, 'malformed frame');
			return;
		}
		let raw: unknown;
		try {
			raw = JSON.parse(data);
		} catch {
			await this.refuse(socket, state, 'malformed');
			return;
		}
		if (state.phase === 'challenge') {
			await this.handshake(socket, state, raw);
			return;
		}
		await this.accept(socket, state, raw);
	}

	private async handshake(
		socket: LinkSocket,
		state: Extract<SocketState, { phase: 'challenge' }>,
		raw: unknown
	): Promise<void> {
		const now = this.deps.now();
		const node = await this.deps.nodes.get(state.nodeId);
		const verdict = await completeHandshake(raw, { node, challenge: state.challenge, now });
		if (!verdict.ok) {
			const revoked = verdict.code === 'unknown_node' || verdict.code === 'node_revoked';
			const code = revoked
				? CLOSE.revoked
				: verdict.code === 'unsupported_version'
					? CLOSE.unsupportedVersion
					: CLOSE.refused;
			await this.refuse(socket, state, verdict.code, { code, reason: verdict.code });
			return;
		}
		socket.writeState({
			phase: 'ready',
			nodeId: state.nodeId,
			refused: 0,
			version: verdict.version
		});
		const lastSeq = this.lastSeq(node?.lastEnvelopeSeq ?? NO_SEQ);
		socket.send(frame({ type: 'ready', version: verdict.version, lastSeq }));
		await this.deliver(socket, now);
		await this.pushSitesSafely(socket);
	}

	// the next sync retries a failure, so one never undoes a handshake that already succeeded
	private async pushSitesSafely(socket: LinkSocket): Promise<void> {
		try {
			await this.pushSites(socket);
		} catch (error) {
			console.error('site map send failed', error);
		}
	}

	// sends this node's organization its site ids when the map differs from what the connection
	// holds; a node that was revoked since the last look gets nothing and is closed
	private async pushSites(socket: LinkSocket): Promise<void> {
		const state = socket.readState();
		if (state?.phase !== 'ready' || !sitesFrameAllowed(state.version)) return;
		const now = this.deps.now();
		const node = await this.deps.nodes.get(state.nodeId);
		if (commandAllowed(node) !== null || node === null) {
			socket.close(CLOSE.revoked, 'node_revoked');
			return;
		}
		const map = siteMapOf(node.orgId, await this.deps.nodes.sites(node.orgId, node.id));
		if (map.truncated) console.warn('site map cut at the contract limit', node.id);
		const digest = await sitesDigest(map.sites);
		if (digest === state.sitesDigest) return;
		const seq = (this.deps.storage.get<number>(OUT_SEQ) ?? 0) + 1;
		const signed = await signSites(
			buildSites(
				{ id: node.id, orgId: node.orgId, publicKey: node.publicKey, state: node.state },
				map.sites,
				{ now, seq, ack: Math.max(0, this.lastSeq(node.lastEnvelopeSeq)) }
			),
			await this.deps.signingKey()
		);
		this.deps.storage.put(OUT_SEQ, seq);
		socket.send(frame(signed));
		const latest = socket.readState();
		if (latest?.phase === 'ready') socket.writeState({ ...latest, sitesDigest: digest });
	}

	// re-reads the map for every connected node and sends it where it changed
	syncSites(): Promise<void> {
		return this.serial(async () => {
			for (const socket of this.deps.sockets()) await this.pushSitesSafely(socket);
		});
	}

	private lastSeq(rowSeq: number): number {
		return Math.max(this.deps.storage.get<number>(IN_SEQ) ?? NO_SEQ, rowSeq);
	}

	private async accept(
		socket: LinkSocket,
		state: Extract<SocketState, { phase: 'ready' }>,
		raw: unknown
	): Promise<void> {
		const now = this.deps.now();
		const node = await this.deps.nodes.get(state.nodeId);
		const verdict = await acceptEnvelope(raw, {
			node,
			lastSeq: this.lastSeq(node?.lastEnvelopeSeq ?? NO_SEQ),
			now
		});
		if (!verdict.ok) {
			const revoked = verdict.code === 'unknown_node' || verdict.code === 'node_revoked';
			await this.refuse(
				socket,
				state,
				verdict.code,
				revoked ? { code: CLOSE.revoked, reason: verdict.code } : undefined
			);
			return;
		}
		const { message } = verdict;
		// the counter moves first, so a failed database write never lets the same message in twice
		this.deps.storage.put(IN_SEQ, message.seq);
		if (state.refused > 0) socket.writeState({ ...state, refused: 0 });
		if (message.type === 'command.result') {
			const applied = applyResult(this.records(), message.body, now);
			if (applied.matched) this.saveRecords(applied.records);
		}
		try {
			await this.deps.nodes.touch(state.nodeId, nodeUpdateOf(message, now));
		} catch (error) {
			console.error('node row update failed', state.nodeId, error);
		}
		if (message.type === 'status' && node !== null) {
			await this.reconcileBoxSites(node, message.body, now);
		}
	}

	// the site list of a status frame against the organization's rows. A failure never undoes the
	// message; the next frame, or the hourly look, tries again
	private async reconcileBoxSites(
		node: NodeRecord,
		body: StatusBody,
		now: number
	): Promise<void> {
		const store = this.deps.boxSites;
		if (store === undefined) return;
		try {
			const frame = { names: body.sites, hashed: body.namesHashed };
			const digest = await frameDigest(frame);
			const held = this.deps.storage.get<{ digest: string; at: number }>(SITE_NAMES);
			if (held?.digest === digest && now - held.at < SITE_NAMES_RECHECK_MS) return;
			const known = await store.known(node.orgId);
			if (known === null) {
				console.warn('too many site rows to compare with the box', node.id);
				return;
			}
			const changes = reconcileBoxSites({
				nodeId: node.id,
				nodeLabel: body.hostname ?? node.hostFacts.hostname ?? `Node ${node.id.slice(-6)}`,
				known,
				frame,
				tokenOf: await tokensFor(node.id, known, frame),
				now
			});
			const { created } = await store.apply(node.orgId, node.id, changes, now);
			if (changes.skipped > 0) {
				console.warn('sites left for the next frame', node.id, created, changes.skipped);
				return;
			}
			this.deps.storage.put(SITE_NAMES, { digest, at: now });
		} catch (error) {
			console.error('site list compare failed', node.id, error);
		}
	}

	private async deliver(socket: LinkSocket, now: number): Promise<void> {
		const settled = settleExpired(this.records(), now);
		const due = deliverable(settled, now);
		for (const record of due) socket.send(frame(record.envelope));
		this.saveRecords(
			markSent(
				settled,
				due.map((record) => record.key),
				now
			)
		);
	}

	private readySocket(): LinkSocket | null {
		return this.deps.sockets().find((socket) => socket.readState()?.phase === 'ready') ?? null;
	}

	// queues when the node is away and sends at once when it is connected; the same operation, step
	// and idempotency key is one command, so a retry returns the first
	sendCommand(nodeId: string, request: CommandRequest): Promise<SendResult> {
		return this.serial(() => this.send(nodeId, request));
	}

	private async send(nodeId: string, request: CommandRequest): Promise<SendResult> {
		const now = this.deps.now();
		const node = await this.deps.nodes.get(nodeId);
		const refusal = commandAllowed(node);
		if (refusal !== null || node === null)
			return { ok: false, code: refusal ?? 'unknown_node' };
		const records = settleExpired(this.records(), now);
		const key = commandKey(request.opId, request.stepId, request.idempotencyKey);
		const existing = records.find((record) => record.key === key);
		if (existing) {
			return {
				ok: true,
				id: existing.envelope.id,
				delivered: existing.sentAt !== null,
				added: false
			};
		}
		const seq = (this.deps.storage.get<number>(OUT_SEQ) ?? 0) + 1;
		const signed = await signCommand(
			buildCommand(
				{ id: node.id, orgId: node.orgId, publicKey: node.publicKey, state: node.state },
				request,
				{ now, seq, ack: Math.max(0, this.lastSeq(node.lastEnvelopeSeq)) }
			),
			await this.deps.signingKey()
		);
		const queued = enqueue(records, signed, now);
		if (!queued.ok) return { ok: false, code: queued.code };
		this.deps.storage.put(OUT_SEQ, seq);
		const socket = this.readySocket();
		if (socket === null) {
			this.saveRecords(queued.records);
			return { ok: true, id: signed.id, delivered: false, added: true };
		}
		socket.send(frame(signed));
		this.saveRecords(markSent(queued.records, [queued.record.key], now));
		return { ok: true, id: signed.id, delivered: true, added: true };
	}

	commandStatus(ref: { opId: string; stepId: string; idempotencyKey: string }): CommandStatus {
		const now = this.deps.now();
		const settled = settleExpired(this.records(), now);
		const record = settled.find(
			(item) => item.key === commandKey(ref.opId, ref.stepId, ref.idempotencyKey)
		);
		if (!record) return { found: false };
		return { found: true, sent: record.sentAt !== null, result: record.result };
	}

	// closes a socket that has not answered its challenge in time; returns when to look again
	expireHandshakes(): number | null {
		const now = this.deps.now();
		let next: number | null = null;
		for (const socket of this.deps.sockets()) {
			const state = socket.readState();
			if (state?.phase !== 'challenge') continue;
			const deadline = state.challenge.ts + HANDSHAKE_MS;
			if (deadline <= now) socket.close(CLOSE.handshakeTimeout, 'handshake timeout');
			else next = next === null ? deadline : Math.min(next, deadline);
		}
		return next;
	}

	// one wake-up: closes late handshakes, refreshes site maps, and says when to wake again
	async tick(): Promise<number | null> {
		const handshake = this.expireHandshakes();
		await this.syncSites();
		const wantsMap = this.deps.sockets().some((socket) => {
			const state = socket.readState();
			return state?.phase === 'ready' && sitesFrameAllowed(state.version);
		});
		if (!wantsMap) return handshake;
		const resync = this.deps.now() + SITES_SYNC_MS;
		return handshake === null ? resync : Math.min(handshake, resync);
	}
}

export interface LinkRoute {
	nodes: NodeStore;
	sessions: { get(nodeId: string): { fetch(request: Request): Promise<Response> } };
}

const refusal = (status: number, code: string) => Response.json({ ok: false, code }, { status });

// only a node the dashboard knows gets a session, so a made-up id never creates one
export async function handleLink(request: Request, route: LinkRoute): Promise<Response> {
	const nodeId = linkNodeId(new URL(request.url));
	if (nodeId === null) return refusal(404, 'unknown_path');
	if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
		return refusal(426, 'upgrade_required');
	}
	const node = await route.nodes.get(nodeId);
	if (node === null) return refusal(404, 'unknown_node');
	if (node.state !== 'active') return refusal(403, 'node_revoked');
	return route.sessions.get(nodeId).fetch(request);
}

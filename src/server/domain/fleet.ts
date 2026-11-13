import { negotiate, sha256Digest, type VersionRange } from '@contracts/common';
import {
	COMMAND_CLASSES,
	FLEET_LINK_VERSION,
	FLEET_TS_WINDOW_MS,
	MAX_SITE_MAP,
	PAIRING_TTL_MS,
	SITES_FRAME_MINOR,
	createChallenge,
	hashClaimToken,
	hostFactsSchema,
	newClaimToken,
	signEnvelope,
	siteMapEntrySchema,
	verifyChallengeResponse,
	verifyEnvelope,
	type Challenge,
	type ChallengeRefusal,
	type CommandEnvelope,
	type EnvelopeRefusal,
	type NodeEnvelope,
	type SitesEnvelope
} from '@contracts/fleet-link';
import type { z } from 'zod';

export type HostFacts = z.infer<typeof hostFactsSchema>;
export type CommandClass = (typeof COMMAND_CLASSES)[number];

export const NO_SEQ = -1;
export const DEFAULT_COMMAND_TTL_MS = 15 * 60_000;
export const MAX_QUEUED_COMMANDS = 100;

export type NodeState = 'active' | 'revoked';

export interface NodeView {
	id: string;
	orgId: string;
	publicKey: string;
	state: NodeState;
}

// #region pairing

export type PairingState = 'pending' | 'claimed' | 'expired' | 'revoked';

export interface Pairing {
	id: string;
	orgId: string;
	claimTokenHash: string;
	state: PairingState;
	createdAt: number;
	expiresAt: number;
	claimedNodeId: string | null;
}

export type ClaimRefusal = 'invalid_token' | 'expired' | 'already_claimed' | 'revoked';

export async function createPairing(input: {
	orgId: string;
	now: number;
	id?: string;
	token?: string;
}): Promise<{ pairing: Pairing; token: string }> {
	const token = input.token ?? newClaimToken();
	return {
		token,
		pairing: {
			id: input.id ?? `pair_${crypto.randomUUID().replaceAll('-', '')}`,
			orgId: input.orgId,
			claimTokenHash: await hashClaimToken(token),
			state: 'pending',
			createdAt: input.now,
			expiresAt: input.now + PAIRING_TTL_MS,
			claimedNodeId: null
		}
	};
}

// a pending pairing past its expiry reads as expired, whatever the row says
export function pairingStateAt(pairing: Pairing, now: number): PairingState {
	if (pairing.state === 'pending' && now >= pairing.expiresAt) return 'expired';
	return pairing.state;
}

// compares without stopping at the first difference; unequal lengths differ at once
export function sameDigest(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export async function claimDecision(
	pairing: Pairing | null,
	token: string,
	now: number
): Promise<{ ok: true } | { ok: false; code: ClaimRefusal }> {
	if (pairing === null) return { ok: false, code: 'invalid_token' };
	if (!sameDigest(pairing.claimTokenHash, await hashClaimToken(token))) {
		return { ok: false, code: 'invalid_token' };
	}
	const state = pairingStateAt(pairing, now);
	if (state === 'pending') return { ok: true };
	if (state === 'claimed') return { ok: false, code: 'already_claimed' };
	return { ok: false, code: state };
}

// #endregion

// #region envelopes from a node

export type AcceptRefusal = EnvelopeRefusal | 'unknown_node' | 'node_revoked';

export type Accepted = { ok: true; message: NodeEnvelope } | { ok: false; code: AcceptRefusal };

// the node's pinned key signs every message; seq has to rise on every message, so a captured one
// never works twice, even inside the timestamp window
export async function acceptEnvelope(
	raw: unknown,
	input: { node: NodeView | null; lastSeq: number; now: number }
): Promise<Accepted> {
	const { node, lastSeq, now } = input;
	if (node === null) return { ok: false, code: 'unknown_node' };
	if (node.state !== 'active') return { ok: false, code: 'node_revoked' };
	const verdict = await verifyEnvelope(raw, {
		publicKey: node.publicKey,
		direction: 'node',
		now
	});
	if (!verdict.ok) return verdict;
	const message = verdict.value as NodeEnvelope;
	if (message.type === 'status' && message.body.nodeId !== node.id) {
		return { ok: false, code: 'wrong_node' };
	}
	if (message.seq <= lastSeq) return { ok: false, code: 'replayed' };
	return { ok: true, message };
}

export interface NodeUpdate {
	seenAt: number;
	seq: number;
	hostFacts?: HostFacts;
	auditHead?: { seq: number; hash: string };
}

// what an accepted message changes on the node's row; findings, metrics and usage only count as
// proof of life here, since their own stores come later
export function nodeUpdateOf(message: NodeEnvelope, now: number): NodeUpdate {
	const update: NodeUpdate = { seenAt: now, seq: message.seq };
	if (message.type === 'status') {
		const { hostname, os, arch, bastionVersion, workerdVersion, mode } = message.body;
		update.hostFacts = {
			...(hostname === undefined ? {} : { hostname }),
			os,
			arch,
			bastionVersion,
			workerdVersion,
			mode
		};
	}
	if (message.type === 'audit.head') {
		update.auditHead = { seq: message.body.seq, hash: message.body.hash };
	}
	return update;
}

// #endregion

// #region handshake

export type HandshakeRefusal = ChallengeRefusal | 'unknown_node' | 'node_revoked' | 'wrong_node';

export function beginHandshake(now: number, nonceBytes?: Uint8Array): Challenge {
	return createChallenge(now, nonceBytes);
}

export type Handshake =
	| { ok: true; version: { major: number; minor: number }; range: VersionRange }
	| { ok: false; code: HandshakeRefusal };

export async function completeHandshake(
	raw: unknown,
	input: { node: NodeView | null; challenge: Challenge; now: number }
): Promise<Handshake> {
	const { node, challenge, now } = input;
	if (node === null) return { ok: false, code: 'unknown_node' };
	if (node.state !== 'active') return { ok: false, code: 'node_revoked' };
	if (now - challenge.ts > FLEET_TS_WINDOW_MS) return { ok: false, code: 'expired' };
	const verdict = await verifyChallengeResponse(raw, {
		publicKey: node.publicKey,
		nonce: challenge.nonce,
		now
	});
	if (!verdict.ok) return verdict;
	if (verdict.value.nodeId !== node.id) return { ok: false, code: 'wrong_node' };
	const agreed = negotiate(verdict.value.range, { current: FLEET_LINK_VERSION });
	if (!agreed.ok) return { ok: false, code: 'unsupported_version' };
	return { ok: true, version: agreed.version, range: verdict.value.range };
}

// #endregion

// #region commands

export type CommandRefusal = 'node_revoked' | 'unknown_node' | 'queue_full';

export interface CommandRequest {
	opId: string;
	stepId: string;
	idempotencyKey: string;
	class: CommandClass;
	action: string;
	params: Record<string, unknown>;
	approval?: 'local' | 'automatic';
	ttlMs?: number;
}

export type UnsignedCommand = Omit<CommandEnvelope, 'sig'>;

// a command to a revoked node is refused before it is built, so nothing signed ever exists for it
export function commandAllowed(node: NodeView | null): CommandRefusal | null {
	if (node === null) return 'unknown_node';
	if (node.state !== 'active') return 'node_revoked';
	return null;
}

export function buildCommand(
	node: NodeView,
	request: CommandRequest,
	input: { now: number; seq: number; ack: number; id?: string }
): UnsignedCommand {
	return {
		v: FLEET_LINK_VERSION.major,
		id: input.id ?? `msg_${crypto.randomUUID().replaceAll('-', '')}`,
		type: 'command',
		ts: input.now,
		seq: input.seq,
		ack: input.ack,
		body: {
			nodeId: node.id as CommandEnvelope['body']['nodeId'],
			opId: request.opId as CommandEnvelope['body']['opId'],
			stepId: request.stepId,
			idempotencyKey: request.idempotencyKey,
			expiresAt: input.now + (request.ttlMs ?? DEFAULT_COMMAND_TTL_MS),
			class: request.class,
			approval: request.approval ?? 'local',
			action: request.action,
			params: request.params
		}
	};
}

export async function signCommand(
	command: UnsignedCommand,
	privateKey: CryptoKey
): Promise<CommandEnvelope> {
	return (await signEnvelope(command, privateKey)) as CommandEnvelope;
}

export type CommandOutcome = 'succeeded' | 'failed' | 'rejected' | 'expired' | 'queued';

export interface CommandRecord {
	key: string;
	envelope: CommandEnvelope;
	sentAt: number | null;
	result: {
		outcome: CommandOutcome;
		code: string | null;
		deploy: { version: string; deployedAt: string } | null;
		at: number;
	} | null;
}

// a command the node holds for local approval has not finished
const isOpen = (record: CommandRecord): boolean =>
	record.result === null || record.result.outcome === 'queued';

export const commandKey = (opId: string, stepId: string, idempotencyKey: string): string =>
	`${opId}|${stepId}|${idempotencyKey}`;

export const MAX_KEPT_COMMANDS = 200;

// keeps the newest records, and drops finished ones before any command still open
export function trimRecords(
	records: readonly CommandRecord[],
	max = MAX_KEPT_COMMANDS
): CommandRecord[] {
	let excess = records.length - max;
	if (excess <= 0) return [...records];
	return records.filter((record) => {
		if (excess > 0 && !isOpen(record)) {
			excess--;
			return false;
		}
		return true;
	});
}

export type QueueResult =
	| { ok: true; records: CommandRecord[]; record: CommandRecord; added: boolean }
	| { ok: false; code: 'queue_full' };

// the same operation, step and key is one command, so a retry queues nothing new
export function enqueue(
	records: readonly CommandRecord[],
	envelope: CommandEnvelope,
	now: number
): QueueResult {
	const key = commandKey(envelope.body.opId, envelope.body.stepId, envelope.body.idempotencyKey);
	const existing = records.find((record) => record.key === key);
	if (existing) return { ok: true, records: [...records], record: existing, added: false };
	const open = records.filter((record) => isOpen(record) && record.envelope.body.expiresAt > now);
	if (open.length >= MAX_QUEUED_COMMANDS) return { ok: false, code: 'queue_full' };
	const record: CommandRecord = { key, envelope, sentAt: null, result: null };
	return { ok: true, records: [...records, record], record, added: true };
}

// a command nobody ran by its expiry reads as expired; it is never sent after
export function settleExpired(records: readonly CommandRecord[], now: number): CommandRecord[] {
	return records.map((record) =>
		isOpen(record) && record.envelope.body.expiresAt <= now
			? {
					...record,
					result: {
						outcome: 'expired' as const,
						code: 'expired',
						deploy: null,
						at: record.envelope.body.expiresAt
					}
				}
			: record
	);
}

// a command sent before a drop goes out again on reconnect; its idempotency key lets the node dedupe
export function deliverable(records: readonly CommandRecord[], now: number): CommandRecord[] {
	return records.filter(
		(record) => record.result === null && record.envelope.body.expiresAt > now
	);
}

export function markSent(
	records: readonly CommandRecord[],
	keys: readonly string[],
	now: number
): CommandRecord[] {
	return records.map((record) =>
		keys.includes(record.key) ? { ...record, sentAt: now } : record
	);
}

export type ResultBody = Extract<NodeEnvelope, { type: 'command.result' }>['body'];

// a result for a command the server never sent is dropped; once a command has finished, a second
// result does not overwrite it
export function applyResult(
	records: readonly CommandRecord[],
	body: ResultBody,
	now: number
): { records: CommandRecord[]; matched: boolean } {
	const key = commandKey(body.opId, body.stepId, body.idempotencyKey);
	const target = records.find((record) => record.key === key);
	if (!target || !isOpen(target)) return { records: [...records], matched: false };
	return {
		matched: true,
		records: records.map((record) =>
			record.key === key
				? {
						...record,
						result: {
							outcome: body.outcome,
							code: body.code,
							deploy: body.deploy,
							at: now
						}
					}
				: record
		)
	};
}

// #endregion

// #region site map

export interface SiteMapRow {
	orgId: string;
	siteId: string;
	host: string;
}

export interface SiteMap {
	sites: SitesEnvelope['body']['sites'];
	truncated: boolean;
}

// only the node's own organization, sorted by id, one entry per id and host; a row the contract
// would refuse is left out so it never makes the whole frame unreadable at the node
export function siteMapOf(orgId: string, rows: readonly SiteMapRow[]): SiteMap {
	const ids = new Set<string>();
	const hosts = new Set<string>();
	const sites: SiteMap['sites'] = [];
	const own = rows.filter((row) => row.orgId === orgId);
	for (const row of own.sort((a, b) =>
		a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0
	)) {
		const entry = siteMapEntrySchema.safeParse({
			siteId: row.siteId,
			host: row.host.toLowerCase()
		});
		if (!entry.success || ids.has(entry.data.siteId) || hosts.has(entry.data.host)) continue;
		ids.add(entry.data.siteId);
		hosts.add(entry.data.host);
		sites.push(entry.data);
	}
	return { sites: sites.slice(0, MAX_SITE_MAP), truncated: sites.length > MAX_SITE_MAP };
}

// a node that agreed to a version below the one that added the frame is never sent it
export function sitesFrameAllowed(version: { major: number; minor: number }): boolean {
	return version.major === FLEET_LINK_VERSION.major && version.minor >= SITES_FRAME_MINOR;
}

export function sitesDigest(sites: SiteMap['sites']): Promise<string> {
	return sha256Digest(JSON.stringify(sites));
}

export type UnsignedSites = Omit<SitesEnvelope, 'sig'>;

export function buildSites(
	node: NodeView,
	sites: SiteMap['sites'],
	input: { now: number; seq: number; ack: number; id?: string }
): UnsignedSites {
	return {
		v: FLEET_LINK_VERSION.major,
		id: input.id ?? `msg_${crypto.randomUUID().replaceAll('-', '')}`,
		type: 'sites',
		ts: input.now,
		seq: input.seq,
		ack: input.ack,
		body: { nodeId: node.id as SitesEnvelope['body']['nodeId'], sites: [...sites] }
	};
}

export async function signSites(
	frame: UnsignedSites,
	privateKey: CryptoKey
): Promise<SitesEnvelope> {
	return (await signEnvelope(frame, privateKey)) as SitesEnvelope;
}

// #endregion

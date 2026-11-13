import { z } from 'zod';
import {
	digestSchema,
	isoTimestamp,
	nodeId,
	omitSig,
	operationId,
	publicKeySchema,
	sha256Digest,
	signatureSchema,
	signCanonical,
	siteId,
	toBase64Url,
	verifyCanonical,
	versionRangeSchema,
	type Verified,
	type VersionRange
} from './common';
import { usageReportSchema } from './usage';

export const FLEET_LINK_VERSION = { major: 1, minor: 1 } as const;
export const SITES_FRAME_MINOR = 1;
export const FLEET_LINK_CONTRACT = 'fleet-link';

export const PAIRING_TTL_MS = 15 * 60_000;
export const FLEET_TS_WINDOW_MS = 5 * 60_000;

export const ENVELOPE_CONTEXT = 'drupflare.fleet-link.envelope.v1';
export const CHALLENGE_CONTEXT = 'drupflare.fleet-link.challenge.v1';

// #region pairing

export const hostFactsSchema = z.object({
	hostname: z.string().min(1).max(253).optional(),
	os: z.string().min(1).max(64),
	arch: z.string().min(1).max(32),
	bastionVersion: z.string().min(1).max(64),
	workerdVersion: z.string().min(1).max(64),
	mode: z.string().min(1).max(64)
});

export const claimTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/);

export const claimRequestSchema = z.object({
	claimToken: claimTokenSchema,
	nodePublicKey: publicKeySchema,
	hostFacts: hostFactsSchema
});

export const claimResponseSchema = z.object({
	nodeId,
	linkUrl: z.url(),
	dashboardPublicKey: publicKeySchema
});

export const PAIRING_STATES = ['pending', 'claimed', 'expired', 'revoked'] as const;

export const pairingSchema = z.object({
	id: z.string().min(8).max(64),
	claimTokenHash: digestSchema,
	state: z.enum(PAIRING_STATES),
	createdAt: isoTimestamp,
	expiresAt: isoTimestamp
});

export function hashClaimToken(token: string): Promise<string> {
	return sha256Digest(token);
}

export function newClaimToken(): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

// #endregion

// #region what leaves the box

export const LEAVES_THE_BOX = [
	{
		type: 'status',
		field: 'nodeId',
		description: 'The node id the dashboard assigned at pairing.'
	},
	{
		type: 'status',
		field: 'hostname',
		description: 'The host name, sent only if the operator allows it.'
	},
	{ type: 'status', field: 'os', description: 'The operating system name.' },
	{ type: 'status', field: 'arch', description: 'The CPU architecture.' },
	{ type: 'status', field: 'bastionVersion', description: 'The bastion version.' },
	{ type: 'status', field: 'workerdVersion', description: 'The workerd version.' },
	{ type: 'status', field: 'mode', description: 'The bastion operating mode.' },
	{
		type: 'status',
		field: 'tenants',
		description: 'Tenant names, hashed if the operator chooses.'
	},
	{ type: 'status', field: 'sites', description: 'Site names, hashed if the operator chooses.' },
	{
		type: 'status',
		field: 'namesHashed',
		description: 'Whether tenant and site names are hashed.'
	},
	{
		type: 'status',
		field: 'capacity',
		description: 'Capacity numbers such as sites used and memory.'
	},
	{
		type: 'findings',
		field: 'findings',
		description: 'Finding codes with a site name and a count, never content.'
	},
	{ type: 'metrics.batch', field: 'windowStart', description: 'Start of the metrics window.' },
	{ type: 'metrics.batch', field: 'windowEnd', description: 'End of the metrics window.' },
	{ type: 'metrics.batch', field: 'requests', description: 'The request count for the window.' },
	{
		type: 'metrics.batch',
		field: 'points',
		description: 'Named numeric samples, never log bodies.'
	},
	{ type: 'audit.head', field: 'seq', description: 'The audit chain length.' },
	{ type: 'audit.head', field: 'hash', description: 'The audit chain head hash.' },
	{ type: 'usage.report', field: 'reportId', description: 'The usage report id.' },
	{ type: 'usage.report', field: 'source', description: 'The reporting component.' },
	{ type: 'usage.report', field: 'sentAt', description: 'When the report was sent.' },
	{ type: 'usage.report', field: 'intervals', description: 'Hourly view counts per site.' },
	{
		type: 'command.result',
		field: 'opId',
		description: 'The operation the command belonged to.'
	},
	{ type: 'command.result', field: 'stepId', description: 'The step the command belonged to.' },
	{
		type: 'command.result',
		field: 'idempotencyKey',
		description: 'The command idempotency key.'
	},
	{ type: 'command.result', field: 'outcome', description: 'Whether the command succeeded.' },
	{ type: 'command.result', field: 'code', description: 'A result code, never content.' },
	{ type: 'command.result', field: 'deploy', description: 'Deploy metadata: version and time.' }
] as const;

export const NEVER_LEAVES_THE_BOX = [
	'site content',
	'databases',
	'secrets',
	'environment values',
	'log bodies'
] as const;

// #endregion

// #region bodies

const code = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

export const statusBodySchema = hostFactsSchema.extend({
	nodeId,
	tenants: z.array(z.string().max(128)),
	sites: z.array(z.string().max(128)),
	namesHashed: z.boolean(),
	capacity: z.record(z.string(), z.number())
});

export const findingsBodySchema = z.object({
	findings: z.array(
		z.object({
			code,
			site: z.string().max(128).nullable(),
			count: z.int().positive()
		})
	)
});

export const metricsBodySchema = z.object({
	windowStart: isoTimestamp,
	windowEnd: isoTimestamp,
	requests: z.int().nonnegative(),
	points: z.array(
		z.object({
			name: code,
			value: z.number(),
			site: z.string().max(128).nullable()
		})
	)
});

export const auditHeadBodySchema = z.object({
	seq: z.int().nonnegative(),
	hash: digestSchema
});

export const COMMAND_CLASSES = ['safe', 'rebuild', 'stateful', 'destructive'] as const;
export const COMMAND_APPROVALS = ['local', 'automatic'] as const;
export const COMMAND_OUTCOMES = ['succeeded', 'failed', 'rejected', 'expired', 'queued'] as const;

export const commandBodySchema = z.object({
	nodeId,
	opId: operationId,
	stepId: z.string().min(1).max(64),
	idempotencyKey: z.string().min(1).max(128),
	expiresAt: z.int().nonnegative(),
	class: z.enum(COMMAND_CLASSES),
	approval: z.enum(COMMAND_APPROVALS),
	action: z.string().min(1).max(64),
	params: z.record(z.string(), z.unknown())
});

export const commandResultBodySchema = z.object({
	opId: operationId,
	stepId: z.string().min(1).max(64),
	idempotencyKey: z.string().min(1).max(128),
	outcome: z.enum(COMMAND_OUTCOMES),
	code: code.nullable(),
	deploy: z.object({ version: z.string().min(1).max(64), deployedAt: isoTimestamp }).nullable()
});

// #region site map

export const MAX_SITE_MAP = 1000;

export const siteMapEntrySchema = z.strictObject({
	siteId,
	host: z.string().min(1).max(253)
});

// a box that has not seen this frame builds no usage.report; a box older than 1.1 ignores the type
export const sitesBodySchema = z
	.strictObject({
		nodeId,
		sites: z.array(siteMapEntrySchema).max(MAX_SITE_MAP)
	})
	.refine(
		({ sites }) =>
			new Set(sites.map((entry) => entry.siteId)).size === sites.length &&
			new Set(sites.map((entry) => entry.host)).size === sites.length,
		{ message: 'site ids and hosts must each be unique' }
	);

// #endregion

// #region envelope

const messageId = z.string().min(8).max(64);

const envelope = <T extends string, B extends z.ZodType>(type: T, body: B) =>
	z.object({
		v: z.literal(FLEET_LINK_VERSION.major),
		id: messageId,
		type: z.literal(type),
		ts: z.int().nonnegative(),
		seq: z.int().nonnegative(),
		ack: z.int().nonnegative(),
		body,
		sig: signatureSchema
	});

export const NODE_MESSAGE_TYPES = [
	'status',
	'findings',
	'metrics.batch',
	'audit.head',
	'usage.report',
	'command.result'
] as const;
export const SERVER_MESSAGE_TYPES = ['command', 'sites'] as const;

export const nodeEnvelopeSchema = z.discriminatedUnion('type', [
	envelope('status', statusBodySchema),
	envelope('findings', findingsBodySchema),
	envelope('metrics.batch', metricsBodySchema),
	envelope('audit.head', auditHeadBodySchema),
	envelope('usage.report', usageReportSchema),
	envelope('command.result', commandResultBodySchema)
]);

export const commandEnvelopeSchema = envelope('command', commandBodySchema);
export const sitesEnvelopeSchema = envelope('sites', sitesBodySchema);

export const serverEnvelopeSchema = z.discriminatedUnion('type', [
	commandEnvelopeSchema,
	sitesEnvelopeSchema
]);

export type NodeEnvelope = z.infer<typeof nodeEnvelopeSchema>;
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
export type SitesEnvelope = z.infer<typeof sitesEnvelopeSchema>;
export type ServerEnvelope = CommandEnvelope | SitesEnvelope;
export type FleetEnvelope = NodeEnvelope | ServerEnvelope;
export type Direction = 'node' | 'server';

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type UnsignedEnvelope = DistOmit<FleetEnvelope, 'sig'>;

export const ENVELOPE_REFUSALS = [
	'malformed',
	'unsupported_version',
	'wrong_direction',
	'bad_signature',
	'expired',
	'future',
	'command_expired',
	'wrong_node',
	'replayed'
] as const;
export type EnvelopeRefusal = (typeof ENVELOPE_REFUSALS)[number];

export async function signEnvelope(
	message: UnsignedEnvelope,
	privateKey: CryptoKey
): Promise<FleetEnvelope> {
	const sig = await signCanonical(ENVELOPE_CONTEXT, message, privateKey);
	return { ...message, sig } as FleetEnvelope;
}

export type VerifyEnvelopeOptions = {
	publicKey: string;
	direction: Direction;
	now: number;
	windowMs?: number;
	seen?: ReadonlySet<string>;
	// the receiving node's own id; a command is refused unless it names this node
	nodeId?: string;
};

export async function verifyEnvelope(
	raw: unknown,
	opts: VerifyEnvelopeOptions
): Promise<Verified<FleetEnvelope, EnvelopeRefusal>> {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { ok: false, code: 'malformed' };
	}
	const version = (raw as { v?: unknown }).v;
	if (typeof version === 'number' && version !== FLEET_LINK_VERSION.major) {
		return { ok: false, code: 'unsupported_version' };
	}
	const parsed =
		opts.direction === 'node'
			? nodeEnvelopeSchema.safeParse(raw)
			: serverEnvelopeSchema.safeParse(raw);
	if (!parsed.success) {
		const type = (raw as { type?: unknown }).type;
		const other = opts.direction === 'node' ? SERVER_MESSAGE_TYPES : NODE_MESSAGE_TYPES;
		const wrong = typeof type === 'string' && (other as readonly string[]).includes(type);
		return { ok: false, code: wrong ? 'wrong_direction' : 'malformed' };
	}
	const message = parsed.data as FleetEnvelope;
	const valid = await verifyCanonical(
		ENVELOPE_CONTEXT,
		omitSig(raw as { sig: string }),
		message.sig,
		opts.publicKey
	);
	if (!valid) return { ok: false, code: 'bad_signature' };
	if (
		(message.type === 'command' || message.type === 'sites') &&
		message.body.nodeId !== opts.nodeId
	) {
		return { ok: false, code: 'wrong_node' };
	}
	const windowMs = opts.windowMs ?? FLEET_TS_WINDOW_MS;
	if (message.ts < opts.now - windowMs) return { ok: false, code: 'expired' };
	if (message.ts > opts.now + windowMs) return { ok: false, code: 'future' };
	if (message.type === 'command' && message.body.expiresAt <= opts.now) {
		return { ok: false, code: 'command_expired' };
	}
	if (opts.seen?.has(message.id)) return { ok: false, code: 'replayed' };
	return { ok: true, value: message };
}

// #endregion

// #region challenge

export const challengeSchema = z.object({
	nonce: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/),
	ts: z.int().nonnegative()
});

export const challengeResponseSchema = z.object({
	v: z.literal(FLEET_LINK_VERSION.major),
	nodeId,
	nonce: challengeSchema.shape.nonce,
	ts: z.int().nonnegative(),
	range: versionRangeSchema,
	sig: signatureSchema
});

export type Challenge = z.infer<typeof challengeSchema>;
export type ChallengeResponse = z.infer<typeof challengeResponseSchema>;

export const CHALLENGE_REFUSALS = [
	'malformed',
	'unsupported_version',
	'bad_signature',
	'wrong_nonce',
	'expired',
	'future'
] as const;
export type ChallengeRefusal = (typeof CHALLENGE_REFUSALS)[number];

export function createChallenge(
	now: number,
	nonceBytes: Uint8Array = crypto.getRandomValues(new Uint8Array(16))
): Challenge {
	return { nonce: toBase64Url(nonceBytes), ts: now };
}

export async function signChallengeResponse(
	fields: { nodeId: string; nonce: string; ts: number; range: VersionRange },
	privateKey: CryptoKey
): Promise<ChallengeResponse> {
	const unsigned = { v: FLEET_LINK_VERSION.major, ...fields };
	const sig = await signCanonical(CHALLENGE_CONTEXT, unsigned, privateKey);
	return { ...unsigned, sig } as ChallengeResponse;
}

export async function verifyChallengeResponse(
	raw: unknown,
	opts: { publicKey: string; nonce: string; now: number; windowMs?: number }
): Promise<Verified<ChallengeResponse, ChallengeRefusal>> {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { ok: false, code: 'malformed' };
	}
	const version = (raw as { v?: unknown }).v;
	if (typeof version === 'number' && version !== FLEET_LINK_VERSION.major) {
		return { ok: false, code: 'unsupported_version' };
	}
	const parsed = challengeResponseSchema.safeParse(raw);
	if (!parsed.success) return { ok: false, code: 'malformed' };
	const response = parsed.data;
	const valid = await verifyCanonical(
		CHALLENGE_CONTEXT,
		omitSig(raw as { sig: string }),
		response.sig,
		opts.publicKey
	);
	if (!valid) return { ok: false, code: 'bad_signature' };
	if (response.nonce !== opts.nonce) return { ok: false, code: 'wrong_nonce' };
	const windowMs = opts.windowMs ?? FLEET_TS_WINDOW_MS;
	if (response.ts < opts.now - windowMs) return { ok: false, code: 'expired' };
	if (response.ts > opts.now + windowMs) return { ok: false, code: 'future' };
	return { ok: true, value: response };
}

// #endregion

export const schemas = {
	hostFacts: hostFactsSchema,
	pairing: pairingSchema,
	claimRequest: claimRequestSchema,
	claimResponse: claimResponseSchema,
	nodeEnvelope: nodeEnvelopeSchema,
	serverEnvelope: serverEnvelopeSchema,
	sitesBody: sitesBodySchema,
	challenge: challengeSchema,
	challengeResponse: challengeResponseSchema
};

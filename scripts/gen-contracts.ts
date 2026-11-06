import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format } from 'prettier';
import { z } from 'zod';
import * as common from '../contracts/src/common';
import {
	omitSig,
	sha256Digest,
	signingInput,
	signingKeyFromSeed,
	toBase64Url,
	utf8,
	type SigningKey
} from '../contracts/src/common';
import * as discovery from '../contracts/src/discovery';
import * as fleetLink from '../contracts/src/fleet-link';
import {
	CHALLENGE_CONTEXT,
	ENVELOPE_CONTEXT,
	FLEET_LINK_VERSION,
	FLEET_TS_WINDOW_MS,
	createChallenge,
	signChallengeResponse,
	signEnvelope,
	type UnsignedEnvelope
} from '../contracts/src/fleet-link';
import * as migrationCutover from '../contracts/src/migration-cutover';
import * as operations from '../contracts/src/operations';
import * as ownerAssertion from '../contracts/src/owner-assertion';
import {
	ASSERTION_CONTEXT,
	MAX_ASSERTION_TTL_MS,
	signAssertion,
	type AssertionScope
} from '../contracts/src/owner-assertion';
import * as releases from '../contracts/src/releases';
import * as siteAuth from '../contracts/src/site-auth';
import {
	DEFAULT_STALE_GRACE_MS,
	LEASE_CONTEXT,
	MAX_LEASE_MS,
	issueLease,
	type AuthorityState
} from '../contracts/src/site-auth';
import * as siteDbConsole from '../contracts/src/site-db-console';
import * as sites from '../contracts/src/sites';
import * as templates from '../contracts/src/templates';
import * as usage from '../contracts/src/usage';
import * as webhooks from '../contracts/src/webhooks';

const root = fileURLToPath(new URL('../', import.meta.url));

const FORMAT = {
	parser: 'json',
	printWidth: 100,
	useTabs: true,
	tabWidth: 4,
	trailingComma: 'none',
	endOfLine: 'lf'
} as const;

// #region json schema

const CONTRACTS = [
	{ name: 'common', version: common.COMMON_VERSION, schemas: common.schemas },
	{ name: 'sites', version: sites.SITES_VERSION, schemas: sites.schemas },
	{ name: 'operations', version: operations.OPERATIONS_VERSION, schemas: operations.schemas },
	{ name: 'fleet-link', version: fleetLink.FLEET_LINK_VERSION, schemas: fleetLink.schemas },
	{
		name: 'owner-assertion',
		version: ownerAssertion.OWNER_ASSERTION_VERSION,
		schemas: ownerAssertion.schemas
	},
	{ name: 'site-auth', version: siteAuth.SITE_AUTH_VERSION, schemas: siteAuth.schemas },
	{ name: 'discovery', version: discovery.DISCOVERY_VERSION, schemas: discovery.schemas },
	{ name: 'releases', version: releases.RELEASES_VERSION, schemas: releases.schemas },
	{ name: 'usage', version: usage.USAGE_VERSION, schemas: usage.schemas },
	{
		name: 'migration-cutover',
		version: migrationCutover.MIGRATION_CUTOVER_VERSION,
		schemas: migrationCutover.schemas
	},
	{
		name: 'site-db-console',
		version: siteDbConsole.SITE_DB_CONSOLE_VERSION,
		schemas: siteDbConsole.schemas
	},
	{ name: 'templates', version: templates.TEMPLATES_VERSION, schemas: templates.schemas },
	{ name: 'webhooks', version: webhooks.WEBHOOKS_VERSION, schemas: webhooks.schemas }
] as const;

function jsonSchemaFile(contract: (typeof CONTRACTS)[number]): unknown {
	const out: Record<string, unknown> = {};
	for (const [name, schema] of Object.entries(contract.schemas as Record<string, z.ZodType>)) {
		const { $schema: _dialect, ...body } = z.toJSONSchema(schema) as Record<string, unknown>;
		out[name] = body;
	}
	return {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		contract: contract.name,
		version: common.formatVersion(contract.version),
		schemas: out
	};
}

// #endregion

// #region vectors

export const VECTOR_NOW = 1_790_000_000_000;
const SITE = 'site_testsite0001';
const OTHER_SITE = 'site_testsite0002';
const OP = 'op_testop000001';
const NODE = 'nod_testnode0001';
const OTHER_NODE = 'nod_testnode0002';
const HOUR = '2026-11-05T12:00:00Z';

type Json = Record<string, unknown>;
type VectorCase = {
	name: string;
	kind: 'envelope' | 'challenge' | 'lease' | 'assertion';
	description: string;
	input: unknown;
	context: Json;
	signingInput?: string;
	expectServing?: string;
	expect: string;
};

const KEY_LABELS = ['node', 'dashboard', 'siteAuth', 'other'] as const;
type KeyLabel = (typeof KEY_LABELS)[number];

async function testKeys(): Promise<Record<KeyLabel, SigningKey & { seed: string }>> {
	const out = {} as Record<KeyLabel, SigningKey & { seed: string }>;
	for (const label of KEY_LABELS) {
		const seed = new Uint8Array(
			await crypto.subtle.digest('SHA-256', utf8(`drupflare-contracts-test-key/${label}`))
		);
		out[label] = { ...(await signingKeyFromSeed(seed)), seed: toBase64Url(seed) };
	}
	return out;
}

function keyFile(keys: Record<KeyLabel, SigningKey & { seed: string }>): Json {
	const out: Json = {};
	for (const label of KEY_LABELS) {
		out[label] = {
			note: 'TEST KEY ONLY. The seed is public on purpose. Never use it outside tests.',
			seed: keys[label].seed,
			publicKey: keys[label].publicKey
		};
	}
	return out;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function reverseKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reverseKeys);
	if (value !== null && typeof value === 'object') {
		const out: Json = {};
		for (const key of Object.keys(value).reverse()) {
			out[key] = reverseKeys((value as Json)[key]);
		}
		return out;
	}
	return value;
}

async function rawSign(key: SigningKey, context: string, text: string): Promise<string> {
	const sig = await crypto.subtle.sign('Ed25519', key.privateKey, utf8(`${context}\n${text}`));
	return toBase64Url(new Uint8Array(sig));
}

// a message whose signature covers the keys in written order instead of canonical order
async function nonCanonical(key: SigningKey, context: string, message: Json): Promise<Json> {
	const body = reverseKeys(omitSig(message as { sig: string })) as Json;
	return { ...body, sig: await rawSign(key, context, JSON.stringify(body)) };
}

function positive(
	cases: VectorCase[],
	spec: Omit<VectorCase, 'expect' | 'signingInput'> & { signing?: string }
): void {
	const { signing, ...rest } = spec;
	cases.push({ ...rest, expect: 'ok', ...(signing ? { signingInput: signing } : {}) });
}

function negative(cases: VectorCase[], spec: Omit<VectorCase, 'signingInput'>): void {
	cases.push(spec);
}

function vectorFile(
	contract: string,
	version: unknown,
	contexts: Json,
	keys: Json,
	cases: VectorCase[]
): Json {
	return {
		contract,
		version: common.formatVersion(version as common.ContractVersion),
		note: 'Generated by scripts/gen-contracts.ts. Do not edit by hand.',
		signingContexts: contexts,
		keys,
		positive: cases.filter((c) => c.expect === 'ok'),
		negative: cases.filter((c) => c.expect !== 'ok')
	};
}

async function fleetLinkVectors(keys: Record<KeyLabel, SigningKey & { seed: string }>) {
	const cases: VectorCase[] = [];
	const nodeCtx = {
		publicKey: keys.node.publicKey,
		direction: 'node',
		now: VECTOR_NOW,
		seen: []
	};
	const serverCtx = {
		...nodeCtx,
		publicKey: keys.dashboard.publicKey,
		direction: 'server',
		nodeId: NODE
	};
	const auditHash = await sha256Digest('audit-head-test');

	const base = { v: FLEET_LINK_VERSION.major, ack: 0, ts: VECTOR_NOW };
	const sign = async (message: Json, key: SigningKey): Promise<Json> =>
		(await signEnvelope(
			message as unknown as UnsignedEnvelope,
			key.privateKey
		)) as unknown as Json;
	const unsigned: Record<string, Json> = {
		status: {
			...base,
			id: 'msg_status_0001',
			type: 'status',
			seq: 1,
			body: {
				nodeId: NODE,
				hostname: 'test-box',
				os: 'linux',
				arch: 'x64',
				bastionVersion: '0.1.0',
				workerdVersion: '1.20260101.0',
				mode: 'standalone',
				tenants: ['tenant-a'],
				sites: ['site-a'],
				namesHashed: false,
				capacity: { sitesUsed: 1, sitesMax: 10, memoryMbUsed: 512 }
			}
		},
		findings: {
			...base,
			id: 'msg_findings_0001',
			type: 'findings',
			seq: 2,
			body: { findings: [{ code: 'memory.trend.rising', site: 'site-a', count: 2 }] }
		},
		metrics: {
			...base,
			id: 'msg_metrics_0001',
			type: 'metrics.batch',
			seq: 3,
			body: {
				windowStart: HOUR,
				windowEnd: '2026-11-05T12:05:00Z',
				requests: 480,
				points: [{ name: 'cpu.ms', value: 1234.5, site: null }]
			}
		},
		audit: {
			...base,
			id: 'msg_audit_0001',
			type: 'audit.head',
			seq: 4,
			body: { seq: 42, hash: auditHash }
		},
		usage: {
			...base,
			id: 'msg_usage_0001',
			type: 'usage.report',
			seq: 5,
			body: {
				reportId: 'usage_report_0001',
				source: 'node',
				sentAt: '2026-11-05T13:00:00Z',
				intervals: [
					{
						siteId: SITE,
						start: HOUR,
						end: '2026-11-05T13:00:00Z',
						accuracy: 'exact',
						views: 120,
						lowerBound: 120,
						observedViews: 118,
						settlement: 'open'
					}
				]
			}
		},
		result: {
			...base,
			id: 'msg_result_0001',
			type: 'command.result',
			seq: 6,
			body: {
				opId: OP,
				stepId: 'step-1',
				idempotencyKey: 'idem-0001',
				outcome: 'succeeded',
				code: null,
				deploy: { version: '1.0.4', deployedAt: HOUR }
			}
		}
	};
	const command: Json = {
		...base,
		id: 'msg_command_0001',
		type: 'command',
		seq: 1,
		body: {
			nodeId: NODE,
			opId: OP,
			stepId: 'step-1',
			idempotencyKey: 'idem-0001',
			expiresAt: VECTOR_NOW + 60_000,
			class: 'safe',
			approval: 'local',
			action: 'health.observe',
			params: {}
		}
	};

	const signedNode = {} as Record<string, Json>;
	for (const [name, message] of Object.entries(unsigned)) {
		signedNode[name] = await sign(message, keys.node);
		positive(cases, {
			name: `node-${name}`,
			kind: 'envelope',
			description: `A signed ${message.type} message from the node.`,
			input: signedNode[name],
			context: nodeCtx,
			signing: signingInput(ENVELOPE_CONTEXT, omitSig(signedNode[name] as { sig: string }))
		});
	}
	const signedCommand = await sign(command, keys.dashboard);
	positive(cases, {
		name: 'server-command',
		kind: 'envelope',
		description: 'A signed command from the dashboard.',
		input: signedCommand,
		context: serverCtx,
		signing: signingInput(ENVELOPE_CONTEXT, omitSig(signedCommand as { sig: string }))
	});
	positive(cases, {
		name: 'reordered-fields-verify',
		kind: 'envelope',
		description: 'Key order on the wire does not matter because signing uses canonical json.',
		input: reverseKeys(signedNode.status),
		context: nodeCtx
	});

	const status = signedNode.status as Json;
	const tampered = clone(status);
	((tampered.body as Json).capacity as Json).sitesMax = 9999;
	negative(cases, {
		name: 'tampered-body',
		kind: 'envelope',
		description: 'The body changed after signing.',
		input: tampered,
		context: nodeCtx,
		expect: 'bad_signature'
	});
	negative(cases, {
		name: 'wrong-key',
		kind: 'envelope',
		description: 'The message is signed by a key the dashboard has not pinned for this node.',
		input: await sign(unsigned.status!, keys.other),
		context: nodeCtx,
		expect: 'bad_signature'
	});
	negative(cases, {
		name: 'expired',
		kind: 'envelope',
		description: 'Signed correctly, but the timestamp is older than the window.',
		input: await sign(
			{ ...unsigned.status!, ts: VECTOR_NOW - FLEET_TS_WINDOW_MS - 1 },
			keys.node
		),
		context: nodeCtx,
		expect: 'expired'
	});
	negative(cases, {
		name: 'future-timestamp',
		kind: 'envelope',
		description: 'Signed correctly, but the timestamp is ahead of the window.',
		input: await sign(
			{ ...unsigned.status!, ts: VECTOR_NOW + FLEET_TS_WINDOW_MS + 1 },
			keys.node
		),
		context: nodeCtx,
		expect: 'future'
	});
	negative(cases, {
		name: 'replayed-id',
		kind: 'envelope',
		description: 'A valid message whose id the receiver has already seen.',
		input: status,
		context: { ...nodeCtx, seen: ['msg_status_0001'] },
		expect: 'replayed'
	});
	negative(cases, {
		name: 'wrong-version',
		kind: 'envelope',
		description: 'The envelope major version is not 1. It is signed correctly.',
		input: await sign({ ...unsigned.status!, v: 2 }, keys.node),
		context: nodeCtx,
		expect: 'unsupported_version'
	});
	negative(cases, {
		name: 'signed-over-written-order',
		kind: 'envelope',
		description: 'The signature covers the keys in written order, not canonical order.',
		input: await nonCanonical(keys.node, ENVELOPE_CONTEXT, status),
		context: nodeCtx,
		expect: 'bad_signature'
	});
	negative(cases, {
		name: 'command-from-node-direction',
		kind: 'envelope',
		description: 'A command presented where only node messages are accepted.',
		input: signedCommand,
		context: nodeCtx,
		expect: 'wrong_direction'
	});
	negative(cases, {
		name: 'command-expired',
		kind: 'envelope',
		description: 'A signed command whose expiresAt has passed.',
		input: await sign(
			{ ...command, body: { ...(command.body as Json), expiresAt: VECTOR_NOW - 1 } },
			keys.dashboard
		),
		context: serverCtx,
		expect: 'command_expired'
	});
	negative(cases, {
		name: 'command-for-another-node',
		kind: 'envelope',
		description: 'A correctly signed command that names a different node than the receiver.',
		input: await sign(
			{ ...command, body: { ...(command.body as Json), nodeId: OTHER_NODE } },
			keys.dashboard
		),
		context: serverCtx,
		expect: 'wrong_node'
	});
	negative(cases, {
		name: 'command-with-no-receiver-id',
		kind: 'envelope',
		description: 'A command is refused when the receiver does not say which node it is.',
		input: signedCommand,
		context: { ...serverCtx, nodeId: undefined },
		expect: 'wrong_node'
	});

	const challenge = createChallenge(VECTOR_NOW, new Uint8Array(16).fill(7));
	const range = { min: { major: 1, minor: 0 }, max: { major: 1, minor: 2 } };
	const response = await signChallengeResponse(
		{ nodeId: NODE, ...challenge, range },
		keys.node.privateKey
	);
	const challengeCtx = {
		publicKey: keys.node.publicKey,
		nonce: challenge.nonce,
		now: VECTOR_NOW
	};
	positive(cases, {
		name: 'challenge-response',
		kind: 'challenge',
		description: 'The node signs the server nonce, its id, the time and its version range.',
		input: response,
		context: challengeCtx,
		signing: signingInput(CHALLENGE_CONTEXT, omitSig(response))
	});
	negative(cases, {
		name: 'challenge-wrong-nonce',
		kind: 'challenge',
		description: 'A correctly signed response to a different nonce.',
		input: response,
		context: { ...challengeCtx, nonce: toBase64Url(new Uint8Array(16).fill(8)) },
		expect: 'wrong_nonce'
	});
	negative(cases, {
		name: 'challenge-expired',
		kind: 'challenge',
		description: 'A correctly signed response older than the window.',
		input: response,
		context: { ...challengeCtx, now: VECTOR_NOW + FLEET_TS_WINDOW_MS + 1 },
		expect: 'expired'
	});
	negative(cases, {
		name: 'challenge-tampered-range',
		kind: 'challenge',
		description: 'The announced version range changed after signing.',
		input: { ...response, range: { ...range, max: { major: 1, minor: 9 } } },
		context: challengeCtx,
		expect: 'bad_signature'
	});
	negative(cases, {
		name: 'challenge-wrong-version',
		kind: 'challenge',
		description: 'The response major version is not 1.',
		input: { ...response, v: 2 },
		context: challengeCtx,
		expect: 'unsupported_version'
	});

	return vectorFile(
		'fleet-link',
		FLEET_LINK_VERSION,
		{ envelope: ENVELOPE_CONTEXT, challenge: CHALLENGE_CONTEXT },
		{
			node: keyFile(keys).node,
			dashboard: keyFile(keys).dashboard,
			other: keyFile(keys).other
		},
		cases
	);
}

async function siteAuthVectors(keys: Record<KeyLabel, SigningKey & { seed: string }>) {
	const cases: VectorCase[] = [];
	const accessRuleHash = await sha256Digest('access-rule-test');
	const authority: AuthorityState = {
		siteId: SITE as AuthorityState['siteId'],
		epoch: 3,
		generation: 7,
		state: 'active',
		risk: 'established',
		limits: { viewsPerMonth: 100000, requestsPerSecond: 50 },
		accessRuleHash
	};
	const ctx = {
		publicKey: keys.siteAuth.publicKey,
		now: VECTOR_NOW + 1000,
		siteId: SITE,
		epoch: 3
	};
	const issue = (patch: Partial<AuthorityState>) =>
		issueLease({ ...authority, ...patch }, VECTOR_NOW, keys.siteAuth.privateKey);

	const lease = await issue({});
	const strict = await issue({ risk: 'new-free' });
	const planGrace = await issue({ state: 'plan-grace' });
	const suspended = await issue({ state: 'suspended' });
	const revoked = await issue({ state: 'revoked' });

	positive(cases, {
		name: 'lease-mode',
		kind: 'lease',
		description: 'An established site gets a reusable lease with a 30 second life.',
		input: lease,
		context: ctx,
		expectServing: 'lease',
		signing: signingInput(LEASE_CONTEXT, omitSig(lease))
	});
	positive(cases, {
		name: 'strict-mode',
		kind: 'lease',
		description: 'A new free site gets a short lease that is valid for one request only.',
		input: strict,
		context: ctx,
		expectServing: 'strict',
		signing: signingInput(LEASE_CONTEXT, omitSig(strict))
	});
	const longest = await issueLease({ ...authority }, VECTOR_NOW, keys.siteAuth.privateKey, {
		leaseMs: MAX_LEASE_MS
	});
	positive(cases, {
		name: 'lease-at-maximum-life',
		kind: 'lease',
		description: 'A lease that lives exactly as long as the contract maximum still serves.',
		input: longest,
		context: ctx,
		expectServing: 'lease'
	});
	positive(cases, {
		name: 'plan-grace-state',
		kind: 'lease',
		description: 'A plan grace period is a non-security state and still serves.',
		input: planGrace,
		context: ctx,
		expectServing: 'lease'
	});
	positive(cases, {
		name: 'availability-grace',
		kind: 'lease',
		description:
			'The lease expired, renewal failed for availability, and the stale grace holds.',
		input: lease,
		context: { ...ctx, now: lease.exp + 60_000, renewalFailed: true },
		expectServing: 'availability-grace'
	});
	positive(cases, {
		name: 'reordered-fields-verify',
		kind: 'lease',
		description: 'Key order on the wire does not matter.',
		input: reverseKeys(lease),
		context: ctx,
		expectServing: 'lease'
	});

	const tampered = { ...clone(suspended), state: 'active' };
	negative(cases, {
		name: 'tampered-state',
		kind: 'lease',
		description: 'A suspended lease edited to say active.',
		input: tampered,
		context: ctx,
		expect: 'bad_signature'
	});
	negative(cases, {
		name: 'wrong-key',
		kind: 'lease',
		description: 'A lease signed by a key other than the SITE_AUTH key.',
		input: await issueLease(authority, VECTOR_NOW, keys.other.privateKey),
		context: ctx,
		expect: 'bad_signature'
	});
	negative(cases, {
		name: 'expired',
		kind: 'lease',
		description: 'Past expiry plus clock skew, with no renewal failure to excuse it.',
		input: lease,
		context: { ...ctx, now: lease.exp + 60_000 },
		expect: 'expired'
	});
	negative(cases, {
		name: 'lease-longer-than-maximum',
		kind: 'lease',
		description: 'A correctly signed lease that lives longer than the contract maximum.',
		input: await issueLease({ ...authority }, VECTOR_NOW, keys.siteAuth.privateKey, {
			leaseMs: MAX_LEASE_MS + 1
		}),
		context: ctx,
		expect: 'malformed'
	});
	negative(cases, {
		name: 'grace-exhausted',
		kind: 'lease',
		description: 'Renewal failed, but the stale grace has run out.',
		input: lease,
		context: { ...ctx, now: lease.exp + DEFAULT_STALE_GRACE_MS + 60_000, renewalFailed: true },
		expect: 'expired'
	});
	negative(cases, {
		name: 'strict-has-no-grace',
		kind: 'lease',
		description: 'A strict lease never rides the availability grace.',
		input: strict,
		context: { ...ctx, now: strict.exp + 60_000, renewalFailed: true },
		expect: 'expired'
	});
	negative(cases, {
		name: 'wrong-epoch',
		kind: 'lease',
		description: 'The hostname changed owner, so the older epoch must not serve.',
		input: lease,
		context: { ...ctx, epoch: 4 },
		expect: 'wrong_epoch'
	});
	negative(cases, {
		name: 'wrong-site',
		kind: 'lease',
		description: 'A lease for another site.',
		input: lease,
		context: { ...ctx, siteId: OTHER_SITE },
		expect: 'wrong_site'
	});
	negative(cases, {
		name: 'revoked-state',
		kind: 'lease',
		description: 'A correctly signed lease for a revoked site.',
		input: revoked,
		context: ctx,
		expect: 'revoked'
	});
	negative(cases, {
		name: 'suspended-state',
		kind: 'lease',
		description: 'A correctly signed lease for a suspended site.',
		input: suspended,
		context: ctx,
		expect: 'suspended'
	});
	negative(cases, {
		name: 'security-state-gets-no-grace',
		kind: 'lease',
		description: 'A suspended site stays refused while renewal fails inside the grace window.',
		input: suspended,
		context: { ...ctx, now: suspended.exp + 60_000, renewalFailed: true },
		expect: 'suspended'
	});
	negative(cases, {
		name: 'wrong-version',
		kind: 'lease',
		description: 'The lease major version is not 1.',
		input: { ...lease, v: 2 },
		context: ctx,
		expect: 'unsupported_version'
	});
	negative(cases, {
		name: 'signed-over-written-order',
		kind: 'lease',
		description: 'The signature covers the keys in written order, not canonical order.',
		input: await nonCanonical(keys.siteAuth, LEASE_CONTEXT, lease as unknown as Json),
		context: ctx,
		expect: 'bad_signature'
	});

	return vectorFile(
		'site-auth',
		siteAuth.SITE_AUTH_VERSION,
		{ lease: LEASE_CONTEXT },
		{ siteAuth: keyFile(keys).siteAuth, other: keyFile(keys).other },
		cases
	);
}

async function ownerAssertionVectors(keys: Record<KeyLabel, SigningKey & { seed: string }>) {
	const cases: VectorCase[] = [];
	const scope = { siteId: SITE, opId: OP, action: 'retire' } as AssertionScope;
	const ctx = {
		pinnedPublicKey: keys.dashboard.publicKey,
		now: VECTOR_NOW + 1000,
		expect: { siteId: SITE, opId: OP, action: 'retire' },
		seen: []
	};
	const id = 'assertion-id-0001';
	const assertion = await signAssertion(scope, VECTOR_NOW, keys.dashboard, { id });

	positive(cases, {
		name: 'valid',
		kind: 'assertion',
		description: 'A 60 second assertion for one operation on one site.',
		input: assertion,
		context: ctx,
		signing: signingInput(ASSERTION_CONTEXT, omitSig(assertion))
	});
	positive(cases, {
		name: 'reordered-fields-verify',
		kind: 'assertion',
		description: 'Key order on the wire does not matter.',
		input: reverseKeys(assertion),
		context: ctx
	});

	negative(cases, {
		name: 'tampered-scope',
		kind: 'assertion',
		description: 'The action changed after signing.',
		input: { ...clone(assertion), scope: { ...assertion.scope, action: 'purge' } },
		context: { ...ctx, expect: { ...ctx.expect, action: 'purge' } },
		expect: 'bad_signature'
	});
	negative(cases, {
		name: 'pinned-key-mismatch',
		kind: 'assertion',
		description: 'The site pins a different dashboard key than the one that signed.',
		input: assertion,
		context: { ...ctx, pinnedPublicKey: keys.other.publicKey },
		expect: 'key_mismatch'
	});
	negative(cases, {
		name: 'signed-by-other-key',
		kind: 'assertion',
		description: 'The kid names the pinned key, but another key signed.',
		input: {
			...assertion,
			sig: (await signAssertion(scope, VECTOR_NOW, keys.other, { id })).sig
		},
		context: ctx,
		expect: 'bad_signature'
	});
	negative(cases, {
		name: 'expired',
		kind: 'assertion',
		description: 'Past expiry plus skew.',
		input: assertion,
		context: { ...ctx, now: assertion.exp + 60_000 },
		expect: 'expired'
	});
	negative(cases, {
		name: 'not-yet-valid',
		kind: 'assertion',
		description: 'Issued in the future beyond the skew.',
		input: assertion,
		context: { ...ctx, now: VECTOR_NOW - 60_000 },
		expect: 'not_yet_valid'
	});
	negative(cases, {
		name: 'replayed-id',
		kind: 'assertion',
		description: 'A valid assertion whose id the site has already seen.',
		input: assertion,
		context: { ...ctx, seen: [id] },
		expect: 'replayed'
	});
	negative(cases, {
		name: 'wrong-site',
		kind: 'assertion',
		description: 'A valid assertion presented to another site.',
		input: assertion,
		context: { ...ctx, expect: { ...ctx.expect, siteId: OTHER_SITE } },
		expect: 'wrong_scope'
	});
	negative(cases, {
		name: 'wrong-operation',
		kind: 'assertion',
		description: 'A valid assertion for a different operation id.',
		input: assertion,
		context: { ...ctx, expect: { ...ctx.expect, opId: 'op_testop000002' } },
		expect: 'wrong_scope'
	});
	negative(cases, {
		name: 'ttl-too-long',
		kind: 'assertion',
		description: 'A correctly signed assertion that lives longer than the 5 minute cap.',
		input: await signAssertion(scope, VECTOR_NOW, keys.dashboard, {
			id,
			ttlMs: MAX_ASSERTION_TTL_MS + 1
		}),
		context: ctx,
		expect: 'ttl_too_long'
	});
	negative(cases, {
		name: 'wrong-version',
		kind: 'assertion',
		description: 'The assertion major version is not 1.',
		input: { ...assertion, v: 2 },
		context: ctx,
		expect: 'unsupported_version'
	});
	negative(cases, {
		name: 'signed-over-written-order',
		kind: 'assertion',
		description: 'The signature covers the keys in written order, not canonical order.',
		input: await nonCanonical(keys.dashboard, ASSERTION_CONTEXT, assertion as unknown as Json),
		context: ctx,
		expect: 'bad_signature'
	});

	return vectorFile(
		'owner-assertion',
		ownerAssertion.OWNER_ASSERTION_VERSION,
		{ assertion: ASSERTION_CONTEXT },
		{ dashboard: keyFile(keys).dashboard, other: keyFile(keys).other },
		cases
	);
}

// #endregion

export async function renderContractFiles(): Promise<Map<string, string>> {
	const files = new Map<string, unknown>();
	for (const contract of CONTRACTS) {
		files.set(`contracts/json-schema/${contract.name}.json`, jsonSchemaFile(contract));
	}
	const keys = await testKeys();
	files.set('contracts/vectors/fleet-link.json', await fleetLinkVectors(keys));
	files.set('contracts/vectors/site-auth.json', await siteAuthVectors(keys));
	files.set('contracts/vectors/owner-assertion.json', await ownerAssertionVectors(keys));
	const out = new Map<string, string>();
	for (const [path, value] of files) {
		const plain = JSON.parse(JSON.stringify(value)) as unknown;
		out.set(path, await format(JSON.stringify(plain), FORMAT));
	}
	return out;
}

export async function writeContractFiles(base: string = root): Promise<string[]> {
	const written: string[] = [];
	for (const [path, text] of await renderContractFiles()) {
		const target = join(base, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, text);
		written.push(path);
	}
	return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const written = await writeContractFiles();
	console.log(`wrote ${written.length} files`);
}

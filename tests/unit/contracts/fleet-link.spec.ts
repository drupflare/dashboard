import { describe, expect, it } from 'vitest';
import {
	generateSigningKey,
	newId,
	omitSig,
	sha256Digest,
	toBase64Url,
	type SigningKey
} from '../../../contracts/src/common';
import {
	CHALLENGE_CONTEXT,
	COMMAND_CLASSES,
	ENVELOPE_CONTEXT,
	FLEET_TS_WINDOW_MS,
	LEAVES_THE_BOX,
	NEVER_LEAVES_THE_BOX,
	PAIRING_TTL_MS,
	auditHeadBodySchema,
	challengeResponseSchema,
	challengeSchema,
	claimRequestSchema,
	claimResponseSchema,
	commandBodySchema,
	commandResultBodySchema,
	createChallenge,
	findingsBodySchema,
	hashClaimToken,
	hostFactsSchema,
	metricsBodySchema,
	newClaimToken,
	nodeEnvelopeSchema,
	pairingSchema,
	serverEnvelopeSchema,
	signChallengeResponse,
	signEnvelope,
	statusBodySchema,
	verifyChallengeResponse,
	verifyEnvelope,
	type UnsignedEnvelope
} from '../../../contracts/src/fleet-link';
import { loadVectors, vectorTests } from './vectors';

const nodeIdValue = newId('nod');
const hostFacts = {
	hostname: 'box-1',
	os: 'linux',
	arch: 'arm64',
	bastionVersion: '0.1.0',
	workerdVersion: '1.20260101.0',
	mode: 'standalone'
};
const status = {
	...hostFacts,
	nodeId: nodeIdValue,
	tenants: ['t'],
	sites: ['s'],
	namesHashed: true,
	capacity: { sites: 1 }
};

function unsignedStatus(overrides: Record<string, unknown> = {}): UnsignedEnvelope {
	return {
		v: 1,
		id: 'msg_test_00001',
		type: 'status',
		ts: 1_000_000,
		seq: 1,
		ack: 0,
		body: status,
		...overrides
	} as unknown as UnsignedEnvelope;
}

describe('pairing schemas', () => {
	it('round-trips a claim request and a claim response', async () => {
		const key = await generateSigningKey();
		const request = { claimToken: newClaimToken(), nodePublicKey: key.publicKey, hostFacts };
		expect(claimRequestSchema.parse(request)).toEqual(request);
		const response = {
			nodeId: nodeIdValue,
			linkUrl: 'https://app.drupflare.com/link/abc',
			dashboardPublicKey: key.publicKey
		};
		expect(claimResponseSchema.parse(response)).toEqual(response);
	});

	it('rejects a short claim token, a bad key and a bad link url', async () => {
		const key = await generateSigningKey();
		expect(
			claimRequestSchema.safeParse({
				claimToken: 'short',
				nodePublicKey: key.publicKey,
				hostFacts
			}).success
		).toBe(false);
		expect(
			claimRequestSchema.safeParse({
				claimToken: newClaimToken(),
				nodePublicKey: 'nope',
				hostFacts
			}).success
		).toBe(false);
		expect(
			claimResponseSchema.safeParse({
				nodeId: nodeIdValue,
				linkUrl: 'not a url',
				dashboardPublicKey: key.publicKey
			}).success
		).toBe(false);
	});

	it('hashes a claim token to a stable digest and generates fresh tokens', async () => {
		const token = newClaimToken();
		expect(await hashClaimToken(token)).toBe(await sha256Digest(token));
		expect(token).not.toBe(newClaimToken());
		const pairing = {
			id: 'pairing_0001',
			claimTokenHash: await hashClaimToken(token),
			state: 'pending',
			createdAt: '2026-11-05T12:00:00Z',
			expiresAt: '2026-11-05T12:15:00Z'
		};
		expect(pairingSchema.parse(pairing)).toEqual(pairing);
		expect(pairingSchema.safeParse({ ...pairing, state: 'done' }).success).toBe(false);
		expect(PAIRING_TTL_MS).toBe(15 * 60_000);
	});

	it('treats the hostname as optional', () => {
		const { hostname: _omit, ...rest } = hostFacts;
		expect(hostFactsSchema.safeParse(rest).success).toBe(true);
		expect(hostFactsSchema.safeParse({ ...rest, os: '' }).success).toBe(false);
	});
});

describe('body schemas', () => {
	it('round-trips each body and rejects an invalid one', async () => {
		const hash = await sha256Digest('x');
		const pairs: [any, unknown, unknown][] = [
			[statusBodySchema, status, { ...status, nodeId: 'bad' }],
			[
				findingsBodySchema,
				{ findings: [{ code: 'a.b', site: null, count: 1 }] },
				{ findings: [{ code: 'has space', site: null, count: 1 }] }
			],
			[
				metricsBodySchema,
				{
					windowStart: '2026-11-05T12:00:00Z',
					windowEnd: '2026-11-05T12:05:00Z',
					requests: 3,
					points: [{ name: 'cpu', value: 1.5, site: 's' }]
				},
				{ windowStart: 'x', windowEnd: 'y', requests: -1, points: [] }
			],
			[auditHeadBodySchema, { seq: 1, hash }, { seq: 1, hash: 'abc' }],
			[
				commandBodySchema,
				{
					opId: newId('op'),
					stepId: 's1',
					idempotencyKey: 'k',
					expiresAt: 5,
					class: 'safe',
					approval: 'local',
					action: 'health',
					params: {}
				},
				{
					opId: newId('op'),
					stepId: 's1',
					idempotencyKey: 'k',
					expiresAt: 5,
					class: 'danger',
					approval: 'local',
					action: 'health',
					params: {}
				}
			],
			[
				commandResultBodySchema,
				{
					opId: newId('op'),
					stepId: 's1',
					idempotencyKey: 'k',
					outcome: 'failed',
					code: 'boom',
					deploy: null
				},
				{
					opId: newId('op'),
					stepId: 's1',
					idempotencyKey: 'k',
					outcome: 'exploded',
					code: null,
					deploy: null
				}
			]
		];
		for (const [schema, good, bad] of pairs) {
			expect(schema.parse(good)).toEqual(good);
			expect(schema.safeParse(bad).success).toBe(false);
		}
		expect(COMMAND_CLASSES).toContain('destructive');
	});
});

describe('what leaves the box', () => {
	const listed = (type: string) =>
		LEAVES_THE_BOX.filter((f) => f.type === type).map((f) => f.field);

	it('lists every top-level field of every node message body', () => {
		const bodies: Record<string, string[]> = {
			status: Object.keys(statusBodySchema.shape),
			findings: Object.keys(findingsBodySchema.shape),
			'metrics.batch': Object.keys(metricsBodySchema.shape),
			'audit.head': Object.keys(auditHeadBodySchema.shape),
			'command.result': Object.keys(commandResultBodySchema.shape)
		};
		for (const [type, keys] of Object.entries(bodies)) {
			expect(listed(type).sort(), type).toEqual([...keys].sort());
		}
		const usage = nodeEnvelopeSchema.options.find(
			(o) => o.shape.type.value === 'usage.report'
		)!;
		expect(listed('usage.report').sort()).toEqual(Object.keys(usage.shape.body.shape).sort());
	});

	it('lists nothing twice, describes each field and names what never leaves', () => {
		const keys = LEAVES_THE_BOX.map((f) => `${f.type}:${f.field}`);
		expect(new Set(keys).size).toBe(keys.length);
		for (const field of LEAVES_THE_BOX) expect(field.description.length).toBeGreaterThan(5);
		expect(NEVER_LEAVES_THE_BOX).toEqual([
			'site content',
			'databases',
			'secrets',
			'environment values',
			'log bodies'
		]);
	});
});

describe('envelope signing', () => {
	it('signs and verifies a message, and the signed message passes its schema', async () => {
		const key = await generateSigningKey();
		const signed = await signEnvelope(unsignedStatus(), key.privateKey);
		expect(nodeEnvelopeSchema.safeParse(signed).success).toBe(true);
		const result = await verifyEnvelope(signed, {
			publicKey: key.publicKey,
			direction: 'node',
			now: 1_000_000
		});
		expect(result.ok).toBe(true);
	});

	it('refuses a body changed after signing, one signed by another key and a spoofed context', async () => {
		const key = await generateSigningKey();
		const other: SigningKey = await generateSigningKey();
		const options = { publicKey: key.publicKey, direction: 'node' as const, now: 1_000_000 };
		const signed = await signEnvelope(unsignedStatus(), key.privateKey);
		const changed = { ...signed, body: { ...status, mode: 'other' } };
		expect(await verifyEnvelope(changed, options)).toEqual({
			ok: false,
			code: 'bad_signature'
		});
		const foreign = await signEnvelope(unsignedStatus(), other.privateKey);
		expect(await verifyEnvelope(foreign, options)).toEqual({
			ok: false,
			code: 'bad_signature'
		});
	});

	it('refuses an unknown field added after signing and accepts one signed in', async () => {
		const key = await generateSigningKey();
		const options = { publicKey: key.publicKey, direction: 'node' as const, now: 1_000_000 };
		const signed = await signEnvelope(unsignedStatus(), key.privateKey);
		expect(await verifyEnvelope({ ...signed, extra: 1 }, options)).toEqual({
			ok: false,
			code: 'bad_signature'
		});
		const future = await signEnvelope(unsignedStatus({ extra: 1 } as never), key.privateKey);
		const result = await verifyEnvelope(future, options);
		expect(result.ok).toBe(true);
		if (result.ok) expect('extra' in result.value).toBe(false);
	});

	it('checks the time window on both sides and at the edge', async () => {
		const key = await generateSigningKey();
		const signed = await signEnvelope(unsignedStatus({ ts: 5_000_000 }), key.privateKey);
		const base = { publicKey: key.publicKey, direction: 'node' as const };
		expect(
			(await verifyEnvelope(signed, { ...base, now: 5_000_000 + FLEET_TS_WINDOW_MS })).ok
		).toBe(true);
		expect(
			await verifyEnvelope(signed, { ...base, now: 5_000_000 + FLEET_TS_WINDOW_MS + 1 })
		).toEqual({
			ok: false,
			code: 'expired'
		});
		expect(
			await verifyEnvelope(signed, { ...base, now: 5_000_000 - FLEET_TS_WINDOW_MS - 1 })
		).toEqual({
			ok: false,
			code: 'future'
		});
		expect((await verifyEnvelope(signed, { ...base, now: 5_000_100, windowMs: 1000 })).ok).toBe(
			true
		);
		expect((await verifyEnvelope(signed, { ...base, now: 5_002_000, windowMs: 1000 })).ok).toBe(
			false
		);
	});

	it('refuses a seen id only when the set holds it', async () => {
		const key = await generateSigningKey();
		const signed = await signEnvelope(unsignedStatus(), key.privateKey);
		const base = { publicKey: key.publicKey, direction: 'node' as const, now: 1_000_000 };
		expect((await verifyEnvelope(signed, { ...base, seen: new Set(['other']) })).ok).toBe(true);
		expect(
			await verifyEnvelope(signed, { ...base, seen: new Set(['msg_test_00001']) })
		).toEqual({
			ok: false,
			code: 'replayed'
		});
	});

	it('refuses non-objects, missing fields and unknown types as malformed', async () => {
		const options = { publicKey: 'x'.repeat(43), direction: 'node' as const, now: 1 };
		for (const raw of [null, 'text', 5, [], {}, { v: 1 }, { v: 1, type: 'nope' }]) {
			expect(await verifyEnvelope(raw, options)).toEqual({ ok: false, code: 'malformed' });
		}
	});

	it('refuses a command on the node side and a node message on the server side', async () => {
		const node = await generateSigningKey();
		const dashboard = await generateSigningKey();
		const command = await signEnvelope(
			{
				v: 1,
				id: 'msg_cmd_000001',
				type: 'command',
				ts: 1,
				seq: 1,
				ack: 0,
				body: {
					opId: newId('op'),
					stepId: 's',
					idempotencyKey: 'k',
					expiresAt: 100,
					class: 'safe',
					approval: 'automatic',
					action: 'a',
					params: {}
				}
			} as UnsignedEnvelope,
			dashboard.privateKey
		);
		expect(serverEnvelopeSchema.safeParse(command).success).toBe(true);
		expect(
			await verifyEnvelope(command, {
				publicKey: dashboard.publicKey,
				direction: 'node',
				now: 1
			})
		).toEqual({ ok: false, code: 'wrong_direction' });
		const statusMessage = await signEnvelope(unsignedStatus({ ts: 1 }), node.privateKey);
		expect(
			await verifyEnvelope(statusMessage, {
				publicKey: node.publicKey,
				direction: 'server',
				now: 1
			})
		).toEqual({ ok: false, code: 'wrong_direction' });
	});

	it('refuses an expired command only after the signature checks out', async () => {
		const dashboard = await generateSigningKey();
		const body = {
			opId: newId('op'),
			stepId: 's',
			idempotencyKey: 'k',
			expiresAt: 50,
			class: 'safe',
			approval: 'local',
			action: 'a',
			params: {}
		};
		const message = (await signEnvelope(
			{
				v: 1,
				id: 'msg_cmd_000002',
				type: 'command',
				ts: 100,
				seq: 1,
				ack: 0,
				body
			} as UnsignedEnvelope,
			dashboard.privateKey
		)) as any;
		const options = { publicKey: dashboard.publicKey, direction: 'server' as const, now: 100 };
		expect(await verifyEnvelope(message, options)).toEqual({
			ok: false,
			code: 'command_expired'
		});
		const forged = { ...message, body: { ...body, expiresAt: 9999 } };
		expect(await verifyEnvelope(forged, options)).toEqual({ ok: false, code: 'bad_signature' });
	});

	it('does not accept a signature made under the challenge context', async () => {
		const key = await generateSigningKey();
		const unsigned = unsignedStatus();
		const sig = await crypto.subtle.sign(
			'Ed25519',
			key.privateKey,
			new TextEncoder().encode(`${CHALLENGE_CONTEXT}\n${JSON.stringify(unsigned)}`)
		);
		const forged = { ...unsigned, sig: toBase64Url(new Uint8Array(sig)) };
		expect(
			await verifyEnvelope(forged, {
				publicKey: key.publicKey,
				direction: 'node',
				now: 1_000_000
			})
		).toEqual({ ok: false, code: 'bad_signature' });
		expect(ENVELOPE_CONTEXT).not.toBe(CHALLENGE_CONTEXT);
	});
});

describe('challenge', () => {
	const range = { min: { major: 1, minor: 0 }, max: { major: 1, minor: 1 } };

	it('creates a nonce that passes its schema and differs per call', () => {
		const a = createChallenge(5);
		expect(challengeSchema.parse(a)).toEqual(a);
		expect(a.nonce).not.toBe(createChallenge(5).nonce);
		expect(createChallenge(5, new Uint8Array(16).fill(1)).nonce).toBe(
			createChallenge(9, new Uint8Array(16).fill(1)).nonce
		);
	});

	it('signs and verifies a response bound to the nonce', async () => {
		const key = await generateSigningKey();
		const challenge = createChallenge(1000);
		const response = await signChallengeResponse(
			{ nodeId: nodeIdValue, ...challenge, range },
			key.privateKey
		);
		expect(challengeResponseSchema.safeParse(response).success).toBe(true);
		const options = { publicKey: key.publicKey, nonce: challenge.nonce, now: 1000 };
		const result = await verifyChallengeResponse(response, options);
		expect(result.ok).toBe(true);
		expect(
			await verifyChallengeResponse(response, { ...options, nonce: createChallenge(1).nonce })
		).toEqual({ ok: false, code: 'wrong_nonce' });
		expect(
			await verifyChallengeResponse({ ...response, nodeId: newId('nod') }, options)
		).toEqual({
			ok: false,
			code: 'bad_signature'
		});
		expect(await verifyChallengeResponse(null, options)).toEqual({
			ok: false,
			code: 'malformed'
		});
		expect(await verifyChallengeResponse({ v: 1 }, options)).toEqual({
			ok: false,
			code: 'malformed'
		});
	});

	it('refuses a response outside the window in either direction', async () => {
		const key = await generateSigningKey();
		const challenge = createChallenge(10_000_000);
		const response = await signChallengeResponse(
			{ nodeId: nodeIdValue, ...challenge, range },
			key.privateKey
		);
		const base = { publicKey: key.publicKey, nonce: challenge.nonce };
		expect(
			await verifyChallengeResponse(response, {
				...base,
				now: 10_000_000 + FLEET_TS_WINDOW_MS + 1
			})
		).toEqual({ ok: false, code: 'expired' });
		expect(
			await verifyChallengeResponse(response, {
				...base,
				now: 10_000_000 - FLEET_TS_WINDOW_MS - 1
			})
		).toEqual({ ok: false, code: 'future' });
	});
});

vectorTests('fleet-link', { envelope: ENVELOPE_CONTEXT, challenge: CHALLENGE_CONTEXT });

describe('fleet-link vector coverage', () => {
	it('covers every refusal the plan names', () => {
		const names = loadVectors('fleet-link').negative.map((c) => c.name);
		expect(names).toEqual(
			expect.arrayContaining([
				'tampered-body',
				'expired',
				'replayed-id',
				'wrong-version',
				'signed-over-written-order',
				'challenge-wrong-nonce'
			])
		);
		const positives = loadVectors('fleet-link').positive.map((c) => c.name);
		expect(positives).toEqual(
			expect.arrayContaining([
				'reordered-fields-verify',
				'server-command',
				'challenge-response'
			])
		);
	});

	it('has a positive vector for every node message type', () => {
		const types = new Set(
			loadVectors('fleet-link')
				.positive.filter((c) => c.kind === 'envelope')
				.map((c) => c.input.type)
		);
		for (const type of [
			'status',
			'findings',
			'metrics.batch',
			'audit.head',
			'usage.report',
			'command.result',
			'command'
		]) {
			expect(types.has(type), type).toBe(true);
		}
	});

	it('signs the vector messages with the documented context line', () => {
		for (const c of loadVectors('fleet-link').positive) {
			if (c.kind !== 'envelope' || !c.signingInput) continue;
			expect(c.signingInput.startsWith(`${ENVELOPE_CONTEXT}\n`)).toBe(true);
			expect(c.signingInput).not.toContain('"sig"');
			expect(JSON.parse(c.signingInput.slice(ENVELOPE_CONTEXT.length + 1))).toEqual(
				omitSig(c.input)
			);
		}
	});
});

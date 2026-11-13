import { describe, expect, it } from 'vitest';
import {
	AttachOrderError,
	CLAIM_HOLD_MS,
	DEFAULT_WAIT_MS,
	advance,
	currentStage,
	decideClaim,
	isComplete,
	isExpired,
	isFailed,
	isProven,
	isUnproven,
	isWaiting,
	pollDelayMs,
	prospectiveEpoch,
	readAttachState,
	startState,
	viewOf,
	visiblyChanged,
	type AttachEvent,
	type AttachState,
	type ClaimRow,
	type Observation
} from '../../../src/server/domain/domain-attach';
import {
	APEX_ROUTING_NOTE,
	ATTACH_STAGES,
	ROUTING_LATER_COPY,
	WAITING_COPY,
	attachFailureReason,
	checkHostname,
	domainRefusalReason,
	hazardText,
	type DnsRecord
} from '../../../src/shared/domain-copy';

const HOST = 'www.example.edu';
const OURS: DnsRecord[] = [
	{
		purpose: 'ownership',
		type: 'TXT',
		name: `_drupflare-challenge.${HOST}`,
		value: 'drupflare-verify=abc'
	},
	{ purpose: 'traffic', type: 'CNAME', name: HOST, value: 'target.example.net' }
];
// what the provider adds once it is asked; its address record repeats ours
const PROVIDED: DnsRecord[] = [
	{ purpose: 'certificate', type: 'TXT', name: `_acme-challenge.${HOST}`, value: 'cert-1' },
	{ purpose: 'traffic', type: 'CNAME', name: HOST, value: 'target.example.net' }
];

const seen = (over: Partial<Observation> = {}): AttachEvent => ({
	type: 'observed',
	observation: {
		hostnameStatus: 'pending',
		certificateStatus: 'pending',
		records: PROVIDED,
		...over
	}
});

function run(...events: AttachEvent[]): AttachState {
	return events.reduce(
		(state, event, index) => advance(state, event, 10 + index),
		startState(HOST, 1)
	);
}

const stagesOf = (state: AttachState) => ATTACH_STAGES.map((stage) => state.stages[stage]);

describe('which hostnames can be attached', () => {
	it('accepts a customer domain and lowercases it', () => {
		expect(checkHostname('  WWW.Example.EDU. ')).toEqual({ ok: true, hostname: HOST });
		expect(checkHostname('xn--bcher-kva.example')).toMatchObject({ ok: true });
	});

	it.each([
		'drupflare.app',
		'site.drupflare.app',
		'a.b.drupflare.app',
		'drupflare.com',
		'x.drupflare.com'
	])('refuses %s because Drupflare holds that zone', (name) => {
		const checked = checkHostname(name);
		expect(checked).toMatchObject({ ok: false, code: 'platform_zone' });
	});

	it('does not treat a lookalike as the platform zone', () => {
		expect(checkHostname('notdrupflare.app')).toMatchObject({ ok: true });
		expect(checkHostname('drupflare.app.example.org')).toMatchObject({ ok: true });
	});

	it.each(['', 'localhost', '10.0.0.1', 'a_b.example.org', '-a.example.org', 'example'])(
		'refuses the invalid name "%s"',
		(name) => {
			expect(checkHostname(name)).toMatchObject({ ok: false, code: 'invalid' });
		}
	);

	it('refuses a wildcard before it checks the shape', () => {
		expect(checkHostname('*.example.org')).toMatchObject({ ok: false, code: 'wildcard' });
	});

	it('reads a refused start as plain text and falls back to the server message', () => {
		expect(domainRefusalReason({ details: { reason: 'platform_zone' }, message: 'x' })).toMatch(
			/keeps this domain/
		);
		expect(domainRefusalReason({ details: null, message: 'plain' })).toBe('plain');
	});
});

describe('the four stages', () => {
	it('starts with every stage waiting and no record', () => {
		const state = startState(HOST, 1);
		expect(stagesOf(state)).toEqual(['waiting', 'waiting', 'waiting', 'waiting']);
		expect(currentStage(state)).toBe('ownership');
		expect(isComplete(state)).toBe(false);
		expect(state.waiting).toBeNull();
	});

	it('opens the ownership stage with the records the owner adds first', () => {
		const state = run({ type: 'requested', records: OURS });
		expect(stagesOf(state)).toEqual(['pending', 'waiting', 'waiting', 'waiting']);
		expect(state.records).toEqual(OURS);
	});

	it('walks every transition in order, each on its own evidence', () => {
		let state = run({ type: 'requested', records: OURS });
		state = advance(state, { type: 'checked' }, 20);
		expect(stagesOf(state)).toEqual(['pending', 'waiting', 'waiting', 'waiting']);
		expect(state.checks).toBe(1);
		state = advance(state, { type: 'proven' }, 21);
		expect(stagesOf(state)).toEqual(['done', 'pending', 'waiting', 'waiting']);
		state = advance(state, { type: 'registered', records: PROVIDED }, 22);
		expect(state.records.map((record) => record.purpose)).toEqual([
			'ownership',
			'traffic',
			'certificate'
		]);
		state = advance(state, seen(), 23);
		expect(stagesOf(state)).toEqual(['done', 'pending', 'waiting', 'waiting']);
		state = advance(state, seen({ hostnameStatus: 'active', certificateStatus: 'active' }), 24);
		expect(stagesOf(state)).toEqual(['done', 'done', 'pending', 'waiting']);
		state = advance(state, { type: 'routed' }, 25);
		expect(stagesOf(state)).toEqual(['done', 'done', 'done', 'pending']);
		state = advance(state, { type: 'verified', answered: false }, 26);
		expect(stagesOf(state)).toEqual(['done', 'done', 'done', 'pending']);
		state = advance(state, { type: 'verified', answered: true }, 27);
		expect(stagesOf(state)).toEqual(['done', 'done', 'done', 'done']);
		expect(isComplete(state)).toBe(true);
		expect(currentStage(state)).toBeNull();
	});

	it('proves ownership once and ignores a second proof', () => {
		const proven = run({ type: 'requested', records: OURS }, { type: 'proven' });
		expect(advance(proven, { type: 'proven' }, 40)).toBe(proven);
	});

	it('refuses an event that skips ahead of the evidence it needs', () => {
		const open = run({ type: 'requested', records: OURS });
		const proven = advance(open, { type: 'proven' }, 30);
		expect(() => advance(open, seen(), 30)).toThrow(AttachOrderError);
		expect(() => advance(open, { type: 'registered', records: PROVIDED }, 30)).toThrow(
			AttachOrderError
		);
		expect(() => advance(open, { type: 'parked', code: 'custom_domains_off' }, 30)).toThrow(
			AttachOrderError
		);
		expect(() => advance(proven, { type: 'routed' }, 30)).toThrow(AttachOrderError);
		expect(() => advance(proven, { type: 'verified', answered: true }, 30)).toThrow(
			AttachOrderError
		);
		for (const event of [{ type: 'checked' }, { type: 'proven' }] as const) {
			expect(() => advance(startState(HOST, 1), event, 30)).toThrow(AttachOrderError);
		}
	});

	it('does not let the provider finish the certificate while ownership is open', () => {
		const open = run({ type: 'requested', records: OURS });
		expect(() =>
			advance(open, seen({ hostnameStatus: 'active', certificateStatus: 'active' }), 31)
		).toThrow(AttachOrderError);
	});

	it('counts a check that changes nothing and does not call it a visible change', () => {
		const before = run({ type: 'requested', records: OURS });
		const after = advance(before, { type: 'checked' }, 40);
		expect(after.checks).toBe(before.checks + 1);
		expect(visiblyChanged(before, after)).toBe(false);
		expect(visiblyChanged(before, advance(after, { type: 'proven' }, 41))).toBe(true);
	});

	it('keeps its own records when the provider sends others and adds the ones it lacks', () => {
		const state = run(
			{ type: 'requested', records: OURS },
			{ type: 'proven' },
			seen({ records: PROVIDED })
		);
		expect(state.records.slice(0, 2)).toEqual(OURS);
		expect(state.records).toHaveLength(3);
		const none = run(
			{ type: 'requested', records: OURS },
			{ type: 'proven' },
			seen({ records: [] })
		);
		expect(none.records).toEqual(OURS);
	});

	it.each(['moved', 'deleted', 'blocked'] as const)(
		'fails the certificate stage when the provider reports the hostname %s',
		(hostnameStatus) => {
			const state = run(
				{ type: 'requested', records: OURS },
				{ type: 'proven' },
				seen({ hostnameStatus })
			);
			expect(stagesOf(state)).toEqual(['done', 'failed', 'waiting', 'waiting']);
			expect(state.reason).toBe('custom_domains_refused');
			expect(isFailed(state)).toBe(true);
		}
	);

	it('fails the routing stage when the hostname is moved while it waits for the address', () => {
		const state = run(
			{ type: 'requested', records: OURS },
			{ type: 'proven' },
			seen({ hostnameStatus: 'active', certificateStatus: 'active' }),
			seen({ hostnameStatus: 'moved', certificateStatus: 'active' })
		);
		expect(stagesOf(state)).toEqual(['done', 'done', 'failed', 'waiting']);
		expect(state.reason).toBe('custom_domains_refused');
	});

	it('fails the certificate stage when the certificate fails', () => {
		const state = run(
			{ type: 'requested', records: OURS },
			{ type: 'proven' },
			seen({ hostnameStatus: 'active', certificateStatus: 'failed' })
		);
		expect(stagesOf(state)).toEqual(['done', 'failed', 'waiting', 'waiting']);
		expect(state.reason).toBe('certificate_failed');
	});

	it('ignores every event after a failure and keeps the first reason', () => {
		const failed = run(
			{ type: 'requested', records: OURS },
			{ type: 'failed', code: 'wait_timed_out' }
		);
		expect(advance(failed, { type: 'failed', code: 'other' }, 50)).toBe(failed);
		expect(advance(failed, { type: 'proven' }, 50)).toBe(failed);
		expect(failed.reason).toBe('wait_timed_out');
	});

	it('parks with ownership kept and the certificate not started', () => {
		const parked = run(
			{ type: 'requested', records: OURS },
			{ type: 'proven' },
			{ type: 'parked', code: 'custom_domains_off' }
		);
		expect(stagesOf(parked)).toEqual(['done', 'waiting', 'waiting', 'waiting']);
		expect(parked.waiting).toBe('custom_domains_off');
		expect(isWaiting(parked)).toBe(true);
		expect(isFailed(parked)).toBe(false);
		expect(isComplete(parked)).toBe(false);
		expect(visiblyChanged(startState(HOST, 1), parked)).toBe(true);
	});

	it('reads a stored state back and drops text that is not one', () => {
		const state = run({ type: 'requested', records: OURS });
		expect(readAttachState(JSON.stringify(state))).toEqual(state);
		expect(readAttachState(null)).toBeNull();
		expect(readAttachState('{')).toBeNull();
		expect(readAttachState('{"policy":"freeze"}')).toBeNull();
	});

	it('reads a stored state from before waiting existed as not waiting', () => {
		const { waiting: _waiting, ...old } = startState(HOST, 1);
		expect(readAttachState(JSON.stringify(old))?.waiting).toBeNull();
	});

	it('polls fast at first and then slowly, and gives up after a bounded number of steps', () => {
		expect(pollDelayMs(0)).toBe(30_000);
		expect(pollDelayMs(10)).toBe(300_000);
		expect(pollDelayMs(40)).toBe(1_800_000);
		let elapsed = 0;
		let steps = 0;
		while (elapsed < DEFAULT_WAIT_MS) {
			elapsed += pollDelayMs(steps++);
		}
		expect(steps).toBeLessThan(250);
	});
});

describe('the view the owner reads', () => {
	it('names each stage in plain words and keeps the records visible after a failure', () => {
		const state = run(
			{ type: 'requested', records: OURS },
			{ type: 'proven' },
			{ type: 'failed', code: 'certificate_failed' }
		);
		const view = viewOf('op_1', state);
		expect(view.status).toBe('failed');
		expect(view.stages.map((stage) => stage.label)).toEqual([
			'Ownership Check',
			'Secure Certificate',
			'Routing',
			'Final Check'
		]);
		expect(view.stages.map((stage) => stage.state)).toEqual([
			'done',
			'failed',
			'waiting',
			'waiting'
		]);
		expect(view.records).toEqual(OURS);
		expect(view.notice).toBeNull();
		expect(view.reason).toBe(attachFailureReason('certificate_failed'));
	});

	it('reports a running, a waiting and a finished attach', () => {
		expect(viewOf('op_1', startState(HOST, 1)).status).toBe('running');
		const waiting = viewOf(
			'op_1',
			run(
				{ type: 'requested', records: OURS },
				{ type: 'proven' },
				{ type: 'parked', code: 'custom_domains_off' }
			)
		);
		expect(waiting).toMatchObject({ status: 'waiting', reason: null, notice: WAITING_COPY });
		expect(waiting.notice).toMatch(/not switched on for Drupflare yet/);
		const done = run(
			{ type: 'requested', records: OURS },
			{ type: 'proven' },
			seen({ hostnameStatus: 'active', certificateStatus: 'active' }),
			{ type: 'routed' },
			{ type: 'verified', answered: true }
		);
		expect(viewOf('op_1', done)).toMatchObject({
			status: 'succeeded',
			reason: null,
			notice: null
		});
	});

	it('keeps infrastructure words out of every line the owner reads', () => {
		const state = run({ type: 'requested', records: OURS });
		const everything = [
			...viewOf('op_1', state).stages.flatMap((stage) => [stage.label, stage.text]),
			WAITING_COPY,
			APEX_ROUTING_NOTE,
			ROUTING_LATER_COPY,
			...(
				['apex_cname', 'conflicting_records', 'caa_blocks', 'second_challenge'] as const
			).map((code) => hazardText(code, ['x'])),
			...[
				'hostname_taken',
				'custom_domains_off',
				'custom_domains_refused',
				'wait_timed_out',
				'site_unreachable',
				'provider_unreachable'
			].map((code) => attachFailureReason(code)!)
		].join(' ');
		for (const word of [
			/worker/i,
			/namespace/i,
			/zone id/i,
			/custom hostname/i,
			/certificate authority/i,
			/cloudflare/i
		]) {
			expect(everything).not.toMatch(word);
		}
	});
});

describe('who holds a hostname', () => {
	const row = (over: Partial<ClaimRow> = {}): ClaimRow => ({
		hostname: HOST,
		organizationId: 'org_a',
		siteId: 'site_a',
		operationId: 'op_a',
		epoch: 3,
		state: 'routed',
		providerId: 'cf_1',
		ownershipEpoch: 3,
		updatedAt: 1_000,
		...over
	});
	const A = { organizationId: 'org_a', siteId: 'site_a' };
	const B = { organizationId: 'org_b', siteId: 'site_b' };

	it('inserts at epoch 1 when nothing holds it', () => {
		expect(decideClaim(null, A, false)).toEqual({ kind: 'insert', epoch: 1 });
	});

	it('keeps the epoch for the same site', () => {
		expect(decideClaim(row(), A, true)).toEqual({ kind: 'keep', epoch: 3 });
	});

	it('refuses another site while the holder is live', () => {
		expect(decideClaim(row(), B, true)).toEqual({ kind: 'refuse' });
		expect(decideClaim(row({ state: 'claimed' }), B, true)).toEqual({ kind: 'refuse' });
	});

	it('hands the hostname over with a higher epoch once the holder is gone or let go', () => {
		expect(decideClaim(row(), B, false)).toMatchObject({ kind: 'takeover', epoch: 4 });
		expect(decideClaim(row({ state: 'released' }), B, true)).toMatchObject({
			kind: 'takeover',
			epoch: 4
		});
	});

	it('bumps the epoch when the same site claims again after letting go', () => {
		expect(decideClaim(row({ state: 'released' }), A, true)).toMatchObject({
			kind: 'takeover',
			epoch: 4
		});
	});

	it('does not treat the same site id in another organisation as the holder', () => {
		const other = { organizationId: 'org_b', siteId: 'site_a' };
		expect(decideClaim(row(), other, true)).toEqual({ kind: 'refuse' });
	});
});

describe('the proof of ownership', () => {
	const row = (over: Partial<ClaimRow> = {}): ClaimRow => ({
		hostname: HOST,
		organizationId: 'org_a',
		siteId: 'site_a',
		operationId: 'op_a',
		epoch: 3,
		state: 'claimed',
		providerId: null,
		ownershipEpoch: 3,
		updatedAt: 1_000,
		...over
	});
	const A = { organizationId: 'org_a', siteId: 'site_a' };
	const B = { organizationId: 'org_b', siteId: 'site_b' };

	it('counts only a proof made under the epoch the claim carries now', () => {
		expect(isProven(row())).toBe(true);
		expect(isProven(row({ ownershipEpoch: 2 }))).toBe(false);
		expect(isProven(row({ ownershipEpoch: null }))).toBe(false);
		expect(isProven(row({ state: 'released' }))).toBe(false);
		expect(isProven(null)).toBe(false);
	});

	it('names the epoch a claim will carry before it is made', () => {
		expect(prospectiveEpoch(null, A, false)).toBe(1);
		expect(prospectiveEpoch(row(), A, true)).toBe(3);
		expect(prospectiveEpoch(row(), B, false)).toBe(4);
		expect(prospectiveEpoch(row({ state: 'released' }), A, true)).toBe(4);
		expect(prospectiveEpoch(row(), B, true)).toBeNull();
	});
});

describe('a claim that waits for its proof', () => {
	const row = (over: Partial<ClaimRow> = {}): ClaimRow => ({
		hostname: HOST,
		organizationId: 'org_a',
		siteId: 'site_a',
		operationId: 'op_a',
		epoch: 3,
		state: 'claimed',
		providerId: null,
		ownershipEpoch: null,
		updatedAt: 1_000,
		...over
	});
	const A = { organizationId: 'org_a', siteId: 'site_a' };
	const B = { organizationId: 'org_b', siteId: 'site_b' };
	const C = { organizationId: 'org_a', siteId: 'site_c' };

	it('holds the name for the same 72 hours the attach waits', () => {
		expect(CLAIM_HOLD_MS).toBe(DEFAULT_WAIT_MS);
		expect(CLAIM_HOLD_MS).toBe(72 * 3_600_000);
	});

	it('is contestable only while it is claimed and unproven', () => {
		expect(isUnproven(row())).toBe(true);
		expect(isUnproven(row({ ownershipEpoch: 2 }))).toBe(true);
		expect(isUnproven(row({ ownershipEpoch: 3 }))).toBe(false);
		expect(isUnproven(row({ state: 'routed' }))).toBe(false);
		expect(isUnproven(row({ state: 'released' }))).toBe(false);
	});

	it('is refused as held when the challenger cannot show proof', () => {
		expect(decideClaim(row(), B, true)).toEqual({ kind: 'refuse' });
		expect(decideClaim(row(), B, true, { now: 2_000 })).toEqual({ kind: 'refuse' });
	});

	it('goes to a challenger who can, at the epoch after the takeover', () => {
		expect(decideClaim(row(), B, true, { contest: true })).toMatchObject({
			kind: 'contest',
			epoch: 4
		});
		expect(decideClaim(row(), C, true, { contest: true })).toMatchObject({
			kind: 'contest',
			epoch: 4
		});
	});

	it('never goes to a challenger while the holder carries a proof for its epoch', () => {
		expect(decideClaim(row({ ownershipEpoch: 3 }), B, true, { contest: true })).toEqual({
			kind: 'refuse'
		});
		expect(decideClaim(row({ state: 'routed' }), B, true, { contest: true })).toEqual({
			kind: 'refuse'
		});
	});

	it('keeps the claim for the same site and organisation', () => {
		expect(decideClaim(row(), A, true, { now: 9e12, contest: true })).toEqual({
			kind: 'keep',
			epoch: 3
		});
	});

	it('expires 72 hours after it was last touched, to the millisecond', () => {
		const edge = 1_000 + CLAIM_HOLD_MS;
		expect(isExpired(row(), edge - 1)).toBe(false);
		expect(isExpired(row(), edge)).toBe(true);
		expect(decideClaim(row(), B, true, { now: edge - 1 })).toEqual({ kind: 'refuse' });
		expect(decideClaim(row(), B, true, { now: edge })).toMatchObject({
			kind: 'expired',
			epoch: 4
		});
	});

	it('never expires once proven, and never without a clock', () => {
		expect(isExpired(row({ ownershipEpoch: 3 }), 9e12)).toBe(false);
		expect(isExpired(row({ state: 'routed' }), 9e12)).toBe(false);
		expect(decideClaim(row(), B, true)).toEqual({ kind: 'refuse' });
	});

	it('names the takeover epoch for the page, and null only for a proven holder', () => {
		expect(prospectiveEpoch(row(), B, true)).toBe(4);
		expect(prospectiveEpoch(row(), B, true, 2_000)).toBe(4);
		expect(prospectiveEpoch(row(), A, true)).toBe(3);
		expect(prospectiveEpoch(row({ ownershipEpoch: 3 }), B, true)).toBeNull();
	});

	it('words the two refusals without naming the other site', () => {
		for (const code of ['hostname_unproven', 'hostname_displaced']) {
			const text = attachFailureReason(code)!;
			expect(text).toMatch(/^[\x20-\x7e]+$/);
			expect(text).not.toMatch(/site_|org_|op_|worker|epoch/i);
		}
		expect(attachFailureReason('hostname_displaced')).toContain('proved ownership');
	});
});

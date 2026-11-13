import { describe, expect, it } from 'vitest';
import {
	AttachOrderError,
	DEFAULT_WAIT_MS,
	advance,
	currentStage,
	decideClaim,
	isComplete,
	isFailed,
	pollDelayMs,
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
	ATTACH_STAGES,
	attachFailureReason,
	checkHostname,
	dnsRecordHint,
	domainRefusalReason,
	type DnsRecord
} from '../../../src/shared/domain-copy';

const HOST = 'www.example.edu';
const RECORDS: DnsRecord[] = [
	{ purpose: 'ownership', type: 'TXT', name: `_cf-custom-hostname.${HOST}`, value: 'own-1' },
	{ purpose: 'certificate', type: 'TXT', name: `_acme-challenge.${HOST}`, value: 'cert-1' },
	{ purpose: 'traffic', type: 'CNAME', name: HOST, value: 'target.example.net' }
];

const seen = (over: Partial<Observation> = {}): AttachEvent => ({
	type: 'observed',
	observation: {
		hostnameStatus: 'pending',
		certificateStatus: 'pending',
		records: RECORDS,
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
	});

	it('opens the ownership stage when the records are requested', () => {
		const state = run({ type: 'requested', records: RECORDS });
		expect(stagesOf(state)).toEqual(['pending', 'waiting', 'waiting', 'waiting']);
		expect(state.records).toEqual(RECORDS);
	});

	it('walks every transition in order, each on its own evidence', () => {
		let state = run({ type: 'requested', records: RECORDS });
		state = advance(state, seen(), 20);
		expect(stagesOf(state)).toEqual(['pending', 'waiting', 'waiting', 'waiting']);
		state = advance(state, seen({ hostnameStatus: 'active' }), 21);
		expect(stagesOf(state)).toEqual(['done', 'pending', 'waiting', 'waiting']);
		state = advance(state, seen({ hostnameStatus: 'active', certificateStatus: 'active' }), 22);
		expect(stagesOf(state)).toEqual(['done', 'done', 'pending', 'waiting']);
		state = advance(state, { type: 'routed' }, 23);
		expect(stagesOf(state)).toEqual(['done', 'done', 'done', 'pending']);
		state = advance(state, { type: 'verified', answered: false }, 24);
		expect(stagesOf(state)).toEqual(['done', 'done', 'done', 'pending']);
		state = advance(state, { type: 'verified', answered: true }, 25);
		expect(stagesOf(state)).toEqual(['done', 'done', 'done', 'done']);
		expect(isComplete(state)).toBe(true);
		expect(currentStage(state)).toBeNull();
	});

	it('lets one observation finish two stages, one after the other', () => {
		const state = run(
			{ type: 'requested', records: RECORDS },
			seen({ hostnameStatus: 'active', certificateStatus: 'active' })
		);
		expect(stagesOf(state)).toEqual(['done', 'done', 'pending', 'waiting']);
	});

	it('never finishes the certificate while ownership is open, whatever the certificate says', () => {
		const state = run(
			{ type: 'requested', records: RECORDS },
			seen({ hostnameStatus: 'pending', certificateStatus: 'active' })
		);
		expect(stagesOf(state)).toEqual(['pending', 'waiting', 'waiting', 'waiting']);
	});

	it('refuses to route before the certificate is done and to verify before routing', () => {
		const early = run(
			{ type: 'requested', records: RECORDS },
			seen({ hostnameStatus: 'active' })
		);
		expect(() => advance(early, { type: 'routed' }, 30)).toThrow(AttachOrderError);
		expect(() => advance(early, { type: 'verified', answered: true }, 30)).toThrow(
			AttachOrderError
		);
		expect(() => advance(startState(HOST, 1), seen(), 30)).toThrow(AttachOrderError);
	});

	it('counts a check that changes nothing and does not call it a visible change', () => {
		const before = run({ type: 'requested', records: RECORDS });
		const after = advance(before, seen(), 40);
		expect(after.checks).toBe(before.checks + 1);
		expect(visiblyChanged(before, after)).toBe(false);
		expect(visiblyChanged(before, advance(after, seen({ hostnameStatus: 'active' }), 41))).toBe(
			true
		);
	});

	it('keeps the old records when the provider sends none', () => {
		const state = run({ type: 'requested', records: RECORDS }, seen({ records: [] }));
		expect(state.records).toEqual(RECORDS);
	});

	it.each(['moved', 'deleted', 'blocked'] as const)(
		'fails the ownership stage when the hostname is %s',
		(hostnameStatus) => {
			const state = run({ type: 'requested', records: RECORDS }, seen({ hostnameStatus }));
			expect(stagesOf(state)).toEqual(['failed', 'waiting', 'waiting', 'waiting']);
			expect(state.reason).toBe('ownership_failed');
			expect(isFailed(state)).toBe(true);
		}
	);

	it('fails the certificate stage when the certificate fails', () => {
		const state = run(
			{ type: 'requested', records: RECORDS },
			seen({ hostnameStatus: 'active', certificateStatus: 'failed' })
		);
		expect(stagesOf(state)).toEqual(['done', 'failed', 'waiting', 'waiting']);
		expect(state.reason).toBe('certificate_failed');
	});

	it('ignores every event after a failure and keeps the first reason', () => {
		const failed = run(
			{ type: 'requested', records: RECORDS },
			{ type: 'failed', code: 'wait_timed_out' }
		);
		expect(advance(failed, { type: 'failed', code: 'other' }, 50)).toBe(failed);
		expect(advance(failed, seen({ hostnameStatus: 'active' }), 50)).toBe(failed);
		expect(failed.reason).toBe('wait_timed_out');
	});

	it('reads a stored state back and drops text that is not one', () => {
		const state = run({ type: 'requested', records: RECORDS });
		expect(readAttachState(JSON.stringify(state))).toEqual(state);
		expect(readAttachState(null)).toBeNull();
		expect(readAttachState('{')).toBeNull();
		expect(readAttachState('{"policy":"freeze"}')).toBeNull();
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
			{ type: 'requested', records: RECORDS },
			seen({ hostnameStatus: 'active' }),
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
		expect(view.records).toEqual(RECORDS);
		expect(view.reason).toBe(attachFailureReason('certificate_failed'));
	});

	it('reports a running and a finished attach', () => {
		expect(viewOf('op_1', startState(HOST, 1)).status).toBe('running');
		const done = run(
			{ type: 'requested', records: RECORDS },
			seen({ hostnameStatus: 'active', certificateStatus: 'active' }),
			{ type: 'routed' },
			{ type: 'verified', answered: true }
		);
		expect(viewOf('op_1', done)).toMatchObject({ status: 'succeeded', reason: null });
	});

	it('keeps infrastructure words out of every line the owner reads', () => {
		const state = run({ type: 'requested', records: RECORDS });
		const everything = [
			...viewOf('op_1', state).stages.flatMap((stage) => [stage.label, stage.text]),
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
			/certificate authority/i
		]) {
			expect(everything).not.toMatch(word);
		}
	});

	it('hints at ALIAS only for the bare domain', () => {
		const cname = RECORDS[2]!;
		expect(dnsRecordHint(cname, 'example.edu')).toMatch(/ALIAS/);
		expect(dnsRecordHint(cname, HOST)).toBeNull();
		expect(dnsRecordHint(RECORDS[0]!, 'example.edu')).toBeNull();
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

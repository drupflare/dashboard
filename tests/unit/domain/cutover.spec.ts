import { describe, expect, it } from 'vitest';
import {
	CUTOVER_STEPS,
	OBSERVATION_OFFSETS_MS,
	POST_WRITE_CHOICES,
	SOURCE_WRITE_POLICIES
} from '../../../contracts/src/migration-cutover';
import {
	REFUSAL_CODES,
	boundaryOf,
	cutoverViewSchema,
	expectedWindowSeconds,
	initialState,
	isTerminal,
	next,
	readState,
	viewOf,
	type CutoverEvent,
	type CutoverState
} from '../../../src/server/domain/cutover';

const AT = '2026-11-12T10:00:00.000Z';

// starts a freeze cutover, feeds the events in order and returns the last transition
function walk(events: CutoverEvent[]) {
	let state: CutoverState = next(initialState('freeze', 90), { type: 'start' }, AT).state;
	let action = next(initialState('freeze', 90), { type: 'start' }, AT).action;
	for (const event of events) {
		const step = next(state, event, AT);
		state = step.state;
		action = step.action;
	}
	return { state, action };
}

const toObserving: CutoverEvent[] = [
	{ type: 'ttl-lowered', previousTtlSeconds: 3600 },
	{ type: 'snapshot-taken', marker: 'snap-1' },
	{ type: 'delta-captured', marker: 'delta-1' },
	{ type: 'validated', problem: null },
	{ type: 'approved' },
	{ type: 'policy-applied' },
	{ type: 'final-delta', marker: 'delta-2', problem: null },
	{ type: 'promoted' },
	{ type: 'routed' }
];

describe('the window an owner is told about', () => {
	const estimate = {
		finalDeltaSeconds: 30,
		promoteSeconds: 20,
		routeSeconds: 10,
		ttlSeconds: 60
	};

	it('adds the DNS cache time for freeze and read-only and not for delta', () => {
		expect(expectedWindowSeconds('freeze', estimate)).toBe(120);
		expect(expectedWindowSeconds('read-only', estimate)).toBe(120);
		expect(expectedWindowSeconds('delta', estimate)).toBe(60);
	});

	it('names every policy', () => {
		for (const policy of SOURCE_WRITE_POLICIES) {
			expect(expectedWindowSeconds(policy, estimate)).toBeGreaterThan(0);
		}
	});
});

describe('the steps in order', () => {
	it('walks the ten steps and names the action each one hands the engine', () => {
		let state = initialState('delta', 45);
		const seen: string[] = [];
		const feed = (event: CutoverEvent) => {
			const step = next(state, event, AT);
			state = step.state;
			seen.push(`${state.step ?? '-'}:${step.action.do}`);
			return step.action;
		};
		expect(feed({ type: 'start' })).toEqual({ do: 'lower-ttl' });
		expect(feed({ type: 'ttl-lowered', previousTtlSeconds: 300 })).toEqual({ do: 'snapshot' });
		expect(feed({ type: 'snapshot-taken', marker: 'snap-1' })).toEqual({
			do: 'capture-delta',
			since: 'snap-1'
		});
		expect(feed({ type: 'delta-captured', marker: 'delta-1' })).toEqual({
			do: 'validate',
			snapshot: 'snap-1',
			delta: 'delta-1'
		});
		expect(feed({ type: 'validated', problem: null })).toEqual({ do: 'await-approval' });
		expect(state.state).toBe('awaiting-approval');
		expect(feed({ type: 'approved' })).toEqual({ do: 'apply-policy', policy: 'delta' });
		expect(feed({ type: 'policy-applied' })).toEqual({
			do: 'final-delta',
			since: 'delta-1',
			snapshot: 'snap-1'
		});
		expect(feed({ type: 'final-delta', marker: 'delta-2', problem: null })).toEqual({
			do: 'promote',
			snapshot: 'snap-1',
			delta: 'delta-2'
		});
		expect(feed({ type: 'promoted' })).toEqual({ do: 'route' });
		expect(state.state).toBe('promoted');
		expect(feed({ type: 'routed' })).toEqual({
			do: 'wait-observation',
			index: 0,
			offsetMs: OBSERVATION_OFFSETS_MS[0]
		});
		expect(state.state).toBe('observing');
		expect(state.previousTtlSeconds).toBe(300);
		expect(seen.map((entry) => entry.split(':')[0])).toEqual([
			'lower-ttl',
			'snapshot',
			'capture-delta',
			'validate',
			'owner-approval',
			'apply-write-policy',
			'final-delta',
			'promote',
			'route',
			'observe'
		]);
		expect(new Set(CUTOVER_STEPS)).toEqual(new Set(seen.map((entry) => entry.split(':')[0])));
	});

	it('records the snapshot and the delta markers it was handed', () => {
		const { state } = walk(toObserving);
		expect(state).toMatchObject({ snapshotMarker: 'snap-1', deltaMarker: 'delta-2' });
	});

	it('takes the four observation points in order and then finishes', () => {
		let state = walk(toObserving).state;
		const actions: string[] = [];
		for (let index = 0; index < OBSERVATION_OFFSETS_MS.length; index++) {
			const step = next(state, { type: 'observed', healthy: true, writes: 0 }, AT);
			state = step.state;
			actions.push(
				step.action.do === 'wait-observation' ? `wait ${step.action.index}` : step.action.do
			);
		}
		expect(actions).toEqual(['wait 1', 'wait 2', 'wait 3', 'finish']);
		expect(next(state, { type: 'finished' }, AT).state.state).toBe('completed');
	});
});

describe('the rollback boundary', () => {
	it('is a DNS reversal until the new site takes a write and not after', () => {
		expect(boundaryOf({ destinationWrites: 0 })).toBe('dns-reversal');
		expect(boundaryOf({ destinationWrites: 1 })).toBe('post-write');
	});

	it('reverses DNS on request while the count is zero', () => {
		const step = next(walk(toObserving).state, { type: 'rollback-requested' }, AT);
		expect(step.action).toEqual({ do: 'reverse' });
		expect(next(step.state, { type: 'reversed' }, AT).state.state).toBe('rolled-back');
	});

	it('refuses a reversal once a write was counted and says what to choose instead', () => {
		let state = walk(toObserving).state;
		state = next(state, { type: 'writes-counted', writes: 2 }, AT).state;
		expect(boundaryOf(state)).toBe('post-write');
		const step = next(state, { type: 'rollback-requested' }, AT);
		expect(step.action).toMatchObject({ do: 'refuse', code: 'reversal_closed' });
		expect(step.state.refusal?.message).toMatch(/keep the new site/);
		expect(step.state.destinationWrites).toBe(2);
		expect(step.state.state).toBe('observing');
	});

	it('never lowers the count', () => {
		let state = walk(toObserving).state;
		state = next(state, { type: 'writes-counted', writes: 5 }, AT).state;
		state = next(state, { type: 'writes-counted', writes: 2 }, AT).state;
		expect(state.destinationWrites).toBe(5);
		state = next(state, { type: 'observed', healthy: true, writes: 1 }, AT).state;
		expect(state.destinationWrites).toBe(5);
	});

	it('records each of the three choices with the count at that moment', () => {
		for (const value of POST_WRITE_CHOICES) {
			let state = walk(toObserving).state;
			state = next(state, { type: 'writes-counted', writes: 3 }, AT).state;
			const step = next(state, { type: 'choice-made', value }, AT);
			expect(step.state.choice).toEqual({ value, writesAtChoice: 3, recordedAt: AT });
			expect(step.action.do).toBe(
				value === 'keep-new'
					? 'wait-observation'
					: value === 'export-changes'
						? 'export-changes'
						: 'reverse'
			);
		}
	});

	it('refuses a choice before the first write and a second choice after one', () => {
		const idle = walk(toObserving).state;
		expect(next(idle, { type: 'choice-made', value: 'keep-new' }, AT).action).toMatchObject({
			code: 'no_writes_yet'
		});
		let state = next(idle, { type: 'writes-counted', writes: 1 }, AT).state;
		state = next(state, { type: 'choice-made', value: 'keep-new' }, AT).state;
		expect(
			next(state, { type: 'choice-made', value: 'abandon-new-data' }, AT).action
		).toMatchObject({ code: 'choice_recorded' });
	});

	it('goes back to the source after an export and records what it could not carry', () => {
		let state = walk(toObserving).state;
		state = next(state, { type: 'writes-counted', writes: 1 }, AT).state;
		state = next(state, { type: 'choice-made', value: 'export-changes' }, AT).state;
		const step = next(
			state,
			{ type: 'changes-exported', reference: 'export-1', cannotCarry: ['uploaded files'] },
			AT
		);
		expect(step.action).toEqual({ do: 'reverse' });
		expect(step.state).toMatchObject({
			exportReference: 'export-1',
			cannotCarry: ['uploaded files']
		});
	});
});

describe('what an observation does', () => {
	it('reverses DNS when the new site is unhealthy and took no write', () => {
		const step = next(
			walk(toObserving).state,
			{ type: 'observed', healthy: false, writes: 0 },
			AT
		);
		expect(step.action).toEqual({ do: 'reverse' });
	});

	it('asks for a choice when the new site is unhealthy after a write', () => {
		const step = next(
			walk(toObserving).state,
			{ type: 'observed', healthy: false, writes: 2 },
			AT
		);
		expect(step.state.needsChoice).toBe(true);
		expect(step.action.do).toBe('wait-observation');
	});

	it('does not ask again once a choice is recorded', () => {
		let state = walk(toObserving).state;
		state = next(state, { type: 'writes-counted', writes: 2 }, AT).state;
		state = next(state, { type: 'choice-made', value: 'keep-new' }, AT).state;
		state = next(state, { type: 'observed', healthy: false, writes: 2 }, AT).state;
		expect(state.needsChoice).toBe(false);
	});

	it('waits for a choice after the last point and gives up when none comes', () => {
		let state = walk(toObserving).state;
		for (let index = 0; index < 3; index++) {
			state = next(state, { type: 'observed', healthy: true, writes: 1 }, AT).state;
		}
		const last = next(state, { type: 'observed', healthy: false, writes: 1 }, AT);
		expect(last.action).toEqual({ do: 'await-choice' });
		const out = next(last.state, { type: 'choice-timed-out' }, AT);
		expect(out.state.state).toBe('failed');
		expect(out.action).toEqual({ do: 'stop' });
	});

	it('never reverses DNS for a check that could not be read, and fails at the last one', () => {
		let state = walk(toObserving).state;
		const first = next(state, { type: 'observation-unreadable' }, AT);
		expect(first.action.do).toBe('wait-observation');
		expect(first.state.lastHealthy).toBe(false);
		state = first.state;
		for (let index = 1; index < 3; index++) {
			state = next(state, { type: 'observation-unreadable' }, AT).state;
		}
		const last = next(state, { type: 'observation-unreadable' }, AT);
		expect(last.state.state).toBe('failed');
		expect(last.action).toEqual({ do: 'stop' });
	});
});

describe('a stop before traffic moves', () => {
	it('unwinds on a conflict found before the approval', () => {
		let state = walk(toObserving.slice(0, 3)).state;
		const step = next(state, { type: 'validated', problem: 'orders differ' }, AT);
		expect(step.action).toEqual({ do: 'unwind' });
		expect(step.state.reason).toContain('orders differ');
		state = next(step.state, { type: 'unwound' }, AT).state;
		expect(state.state).toBe('rolled-back');
	});

	it('refuses to promote on a conflict in the last delta', () => {
		const state = walk(toObserving.slice(0, 5)).state;
		const step = next(
			next(state, { type: 'policy-applied' }, AT).state,
			{ type: 'final-delta', marker: 'delta-2', problem: 'row 4 differs' },
			AT
		);
		expect(step.action).toEqual({ do: 'unwind' });
		expect(step.state.reason).toContain('was not promoted');
	});

	it('unwinds when nobody approves', () => {
		const state = walk(toObserving.slice(0, 4)).state;
		const step = next(state, { type: 'approval-timed-out' }, AT);
		expect(step.action).toEqual({ do: 'unwind' });
		expect(step.state.reason).toContain('nothing was changed');
	});

	it('unwinds on a failed step before the route, reverses at the route and stops after it', () => {
		const failed: CutoverEvent = { type: 'step-failed', reason: 'it broke' };
		expect(next(walk(toObserving.slice(0, 2)).state, failed, AT).action).toEqual({
			do: 'unwind'
		});
		expect(next(walk(toObserving.slice(0, 7)).state, failed, AT).action).toEqual({
			do: 'unwind'
		});
		expect(next(walk(toObserving.slice(0, 8)).state, failed, AT).action).toEqual({
			do: 'reverse'
		});
		const after = next(walk(toObserving).state, failed, AT);
		expect(after.action).toEqual({ do: 'stop' });
		expect(after.state.state).toBe('failed');
	});

	it('ends failed when an undo cannot finish', () => {
		const step = next(walk(toObserving).state, { type: 'stuck', reason: 'no route' }, AT);
		expect(step.state).toMatchObject({ state: 'failed', reason: 'no route' });
	});
});

describe('the table as a whole', () => {
	const eventTypes: CutoverEvent['type'][] = [
		'start',
		'ttl-lowered',
		'snapshot-taken',
		'delta-captured',
		'validated',
		'approved',
		'approval-timed-out',
		'policy-applied',
		'final-delta',
		'promoted',
		'routed',
		'observed',
		'observation-unreadable',
		'writes-counted',
		'rollback-requested',
		'choice-made',
		'choice-timed-out',
		'changes-exported',
		'reversed',
		'unwound',
		'finished',
		'step-failed',
		'stuck'
	];
	const sample = (type: CutoverEvent['type']): CutoverEvent =>
		({
			type,
			previousTtlSeconds: 60,
			marker: 'm-1',
			problem: null,
			healthy: true,
			writes: 1,
			value: 'keep-new',
			reference: 'r',
			cannotCarry: [],
			reason: 'x'
		}) as unknown as CutoverEvent;

	it('answers every event at every step with a transition or a refusal, never an error', () => {
		const states = [initialState('freeze', null)];
		let state = next(states[0]!, { type: 'start' }, AT).state;
		states.push(state);
		for (const event of toObserving) {
			state = next(state, event, AT).state;
			states.push(state);
		}
		for (const from of states) {
			for (const type of eventTypes) {
				const step = next(from, sample(type), AT);
				expect(step.action).toBeDefined();
				if (step.action.do === 'refuse') expect(REFUSAL_CODES).toContain(step.action.code);
			}
		}
	});

	it('refuses everything once the cutover is finished', () => {
		for (const done of ['completed', 'rolled-back', 'failed'] as const) {
			const state = { ...walk(toObserving).state, state: done };
			expect(isTerminal(state)).toBe(true);
			for (const type of eventTypes) {
				expect(next(state, sample(type), AT).action).toMatchObject({
					do: 'refuse',
					code: 'finished'
				});
			}
		}
	});

	it('stamps the time of the event on the state', () => {
		expect(next(initialState('freeze', null), { type: 'start' }, AT).state.updatedAt).toBe(AT);
	});
});

describe('what the owner reads', () => {
	it('builds a view that parses and says the source was never destroyed', () => {
		const { state } = walk(toObserving);
		const view = viewOf('op_x', 'site_x', state, [
			{ id: 'lease', name: 'Take the lease', state: 'succeeded' }
		]);
		expect(cutoverViewSchema.parse(view)).toEqual(view);
		expect(view).toMatchObject({ sourceDestroyed: false, boundary: 'dns-reversal' });
	});

	it('reads the state back from the cursor and treats anything else as not started', () => {
		const { state } = walk(toObserving);
		expect(readState(JSON.stringify(state))).toEqual(state);
		expect(readState(null)).toBeNull();
		expect(readState('not json')).toBeNull();
		expect(readState('{"a":1}')).toBeNull();
	});
});

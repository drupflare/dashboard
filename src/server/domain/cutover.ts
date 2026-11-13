import { z } from 'zod';
import {
	CUTOVER_STATES,
	OBSERVATION_OFFSETS_MS,
	cutoverStep,
	postWriteChoice,
	rollbackBoundary,
	sourceWritePolicy,
	type Cutover,
	type RollbackBoundary
} from '../../../contracts/src/migration-cutover';

export type SourceWritePolicy = Cutover['policy'];
export type CutoverStateName = Cutover['state'];
export type CutoverStep = NonNullable<Cutover['step']>;
export type PostWriteChoice = NonNullable<Cutover['choice']>['value'];

export const REFUSAL_CODES = [
	'no_writes_yet',
	'reversal_closed',
	'choice_recorded',
	'finished',
	'unexpected'
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export interface CutoverState {
	state: CutoverStateName;
	step: CutoverStep | null;
	policy: SourceWritePolicy;
	expectedWindowSeconds: number | null;
	previousTtlSeconds: number | null;
	snapshotMarker: string | null;
	deltaMarker: string | null;
	destinationWrites: number;
	// observation points already taken; the next one is OBSERVATION_OFFSETS_MS[observed]
	observed: number;
	lastHealthy: boolean | null;
	needsChoice: boolean;
	choice: Cutover['choice'];
	exportReference: string | null;
	// the new site's write number the first file was read to; the second read starts after it
	exportThrough: number | null;
	cannotCarry: string[];
	// the read after the address moved back: waiting for old caches to expire, saved, found
	// nothing new, or could not be read
	finalChanges: FinalChanges | null;
	finalStatements: number;
	refusal: { code: RefusalCode; message: string } | null;
	reason: string | null;
	updatedAt: string | null;
}

export const FINAL_CHANGES = ['waiting', 'ready', 'none', 'unread'] as const;
export type FinalChanges = (typeof FINAL_CHANGES)[number];

export type CutoverEvent =
	| { type: 'start' }
	| { type: 'ttl-lowered'; previousTtlSeconds: number }
	| { type: 'snapshot-taken'; marker: string }
	| { type: 'delta-captured'; marker: string }
	| { type: 'validated'; problem: string | null }
	| { type: 'approved' }
	| { type: 'approval-timed-out' }
	| { type: 'policy-applied' }
	| { type: 'final-delta'; marker: string; problem: string | null }
	| { type: 'promoted' }
	| { type: 'routed' }
	| { type: 'observed'; healthy: boolean; writes: number }
	| { type: 'observation-unreadable' }
	| { type: 'writes-counted'; writes: number }
	| { type: 'rollback-requested' }
	| { type: 'choice-made'; value: PostWriteChoice }
	| { type: 'choice-timed-out' }
	| { type: 'changes-exported'; reference: string; cannotCarry: string[]; through: number }
	| {
			type: 'final-changes-exported';
			cannotCarry: string[];
			statements: number;
	  }
	| { type: 'final-changes-unreadable' }
	| { type: 'reversed' }
	| { type: 'unwound' }
	| { type: 'finished' }
	| { type: 'step-failed'; reason: string }
	| { type: 'stuck'; reason: string };

export type CutoverAction =
	| { do: 'lower-ttl' }
	| { do: 'snapshot' }
	| { do: 'capture-delta'; since: string }
	| { do: 'validate'; snapshot: string; delta: string }
	| { do: 'await-approval' }
	| { do: 'apply-policy'; policy: SourceWritePolicy }
	| { do: 'final-delta'; since: string; snapshot: string }
	| { do: 'promote'; snapshot: string; delta: string }
	| { do: 'route' }
	| { do: 'wait-observation'; index: number; offsetMs: number }
	| { do: 'await-choice' }
	| { do: 'export-changes' }
	| { do: 'final-changes'; since: number }
	| { do: 'reverse' }
	| { do: 'unwind' }
	| { do: 'finish' }
	| { do: 'refuse'; code: RefusalCode; message: string }
	| { do: 'stop' };

export interface Transition {
	state: CutoverState;
	action: CutoverAction;
}

export const TERMINAL_STATES: readonly CutoverStateName[] = ['completed', 'rolled-back', 'failed'];

export const isTerminal = (state: CutoverState) => TERMINAL_STATES.includes(state.state);

// #region the window the owner is told about

export interface WindowEstimate {
	finalDeltaSeconds: number;
	promoteSeconds: number;
	routeSeconds: number;
	ttlSeconds: number;
}

// freeze and read-only hold writes until DNS has moved; delta holds them only for the final copy
export function expectedWindowSeconds(policy: SourceWritePolicy, estimate: WindowEstimate): number {
	const work = estimate.finalDeltaSeconds + estimate.promoteSeconds + estimate.routeSeconds;
	return policy === 'delta' ? work : work + estimate.ttlSeconds;
}

// #endregion

// #region the transition table

export function initialState(
	policy: SourceWritePolicy,
	expectedWindowSeconds: number | null
): CutoverState {
	return {
		state: 'planned',
		step: null,
		policy,
		expectedWindowSeconds,
		previousTtlSeconds: null,
		snapshotMarker: null,
		deltaMarker: null,
		destinationWrites: 0,
		observed: 0,
		lastHealthy: null,
		needsChoice: false,
		choice: null,
		exportReference: null,
		exportThrough: null,
		cannotCarry: [],
		finalChanges: null,
		finalStatements: 0,
		refusal: null,
		reason: null,
		updatedAt: null
	};
}

export const boundaryOf = (state: Pick<CutoverState, 'destinationWrites'>): RollbackBoundary =>
	rollbackBoundary(state.destinationWrites);

type Of<T extends CutoverEvent['type']> = Extract<CutoverEvent, { type: T }>;
type Handler<T extends CutoverEvent['type']> = (state: CutoverState, event: Of<T>) => Transition;
type Table = { [K in CutoverEvent['type']]?: Handler<K> };

const advance = (state: CutoverState, patch: Partial<CutoverState>): CutoverState => ({
	...state,
	...patch,
	refusal: null
});

const need = (value: string | null, what: string): string => {
	if (value === null) throw new CutoverRuleError(`the ${what} is not recorded`);
	return value;
};

export class CutoverRuleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CutoverRuleError';
	}
}

const REFUSALS: Record<RefusalCode, string> = {
	no_writes_yet: 'The new site has not accepted a write yet, so there is no choice to make.',
	reversal_closed:
		'The new site has accepted writes, so a DNS reversal would lose them. Choose to keep the new site, abandon its new data, or export its new changes.',
	choice_recorded: 'A choice is already recorded for this cutover.',
	finished: 'This cutover has finished.',
	unexpected: 'This cannot be done at this point in the cutover.'
};

const refuse = (state: CutoverState, code: RefusalCode): Transition => ({
	state: { ...state, refusal: { code, message: REFUSALS[code] } },
	action: { do: 'refuse', code, message: REFUSALS[code] }
});

const stopRun = (state: CutoverState, reason: string): Transition => ({
	state: advance(state, { state: 'running', reason }),
	action: { do: 'unwind' }
});

const nextWait = (state: CutoverState): CutoverAction => {
	const offsetMs = OBSERVATION_OFFSETS_MS[state.observed];
	if (offsetMs !== undefined) return { do: 'wait-observation', index: state.observed, offsetMs };
	return state.needsChoice ? { do: 'await-choice' } : { do: 'stop' };
};

// all observations taken: a site that was never in trouble finishes, one waiting on a choice waits
function afterObservation(state: CutoverState): Transition {
	if (state.observed >= OBSERVATION_OFFSETS_MS.length && !state.needsChoice) {
		return { state: advance(state, { state: 'running' }), action: { do: 'finish' } };
	}
	return { state, action: nextWait(state) };
}

const BEFORE_ROUTE: readonly (CutoverStep | 'start')[] = [
	'start',
	'lower-ttl',
	'snapshot',
	'capture-delta',
	'validate',
	'owner-approval',
	'apply-write-policy',
	'final-delta',
	'promote'
];

// a failure before traffic moved unwinds the source; one at the route may have moved some, so it
// goes back to the source; one while observing leaves the new site serving and says so
const common: Table = {
	'step-failed': (state, event) => {
		if (BEFORE_ROUTE.includes(state.step ?? 'start')) return stopRun(state, event.reason);
		if (state.step === 'route') {
			return {
				state: advance(state, { state: 'running', reason: event.reason }),
				action: { do: 'reverse' }
			};
		}
		return {
			state: advance(state, { state: 'failed', reason: event.reason }),
			action: { do: 'stop' }
		};
	},
	// an undo that could not finish needs a person, so nothing more runs
	stuck: (state, event) => ({
		state: advance(state, { state: 'failed', reason: event.reason }),
		action: { do: 'stop' }
	}),
	reversed: (state) => ({
		state: advance(state, { state: 'rolled-back' }),
		action: { do: 'stop' }
	}),
	unwound: (state) => ({
		state: advance(state, { state: 'rolled-back' }),
		action: { do: 'stop' }
	})
};

const handlers: Record<CutoverStep | 'start', Table> = {
	start: {
		start: (state) => ({
			state: advance(state, { state: 'running', step: 'lower-ttl' }),
			action: { do: 'lower-ttl' }
		})
	},
	'lower-ttl': {
		'ttl-lowered': (state, event) => ({
			state: advance(state, {
				step: 'snapshot',
				previousTtlSeconds: event.previousTtlSeconds
			}),
			action: { do: 'snapshot' }
		})
	},
	snapshot: {
		'snapshot-taken': (state, event) => ({
			state: advance(state, { step: 'capture-delta', snapshotMarker: event.marker }),
			action: { do: 'capture-delta', since: event.marker }
		})
	},
	'capture-delta': {
		'delta-captured': (state, event) => ({
			state: advance(state, { step: 'validate', deltaMarker: event.marker }),
			action: {
				do: 'validate',
				snapshot: need(state.snapshotMarker, 'snapshot marker'),
				delta: event.marker
			}
		})
	},
	validate: {
		validated: (state, event) =>
			event.problem === null
				? {
						state: advance(state, {
							state: 'awaiting-approval',
							step: 'owner-approval'
						}),
						action: { do: 'await-approval' }
					}
				: stopRun(state, event.problem)
	},
	'owner-approval': {
		approved: (state) => ({
			state: advance(state, { state: 'running', step: 'apply-write-policy' }),
			action: { do: 'apply-policy', policy: state.policy }
		}),
		'approval-timed-out': (state) =>
			stopRun(state, 'No one approved the cutover in time, so nothing was changed.')
	},
	'apply-write-policy': {
		'policy-applied': (state) => ({
			state: advance(state, { step: 'final-delta' }),
			action: {
				do: 'final-delta',
				since: need(state.deltaMarker, 'delta marker'),
				snapshot: need(state.snapshotMarker, 'snapshot marker')
			}
		})
	},
	'final-delta': {
		'final-delta': (state, event) =>
			event.problem === null
				? {
						state: advance(state, { step: 'promote', deltaMarker: event.marker }),
						action: {
							do: 'promote',
							snapshot: need(state.snapshotMarker, 'snapshot marker'),
							delta: event.marker
						}
					}
				: stopRun(
						state,
						`The last changes conflict with the new site, so it was not promoted: ${event.problem}`
					)
	},
	promote: {
		promoted: (state) => ({
			state: advance(state, { state: 'promoted', step: 'route' }),
			action: { do: 'route' }
		})
	},
	route: {
		routed: (state) => {
			const next = advance(state, { state: 'observing', step: 'observe' });
			return { state: next, action: nextWait(next) };
		}
	},
	observe: {
		observed: (state, event) => {
			const writes = Math.max(state.destinationWrites, event.writes);
			const observed = state.observed + 1;
			const taken = {
				...state,
				destinationWrites: writes,
				observed,
				lastHealthy: event.healthy
			};
			if (event.healthy) return afterObservation(advance(taken, {}));
			if (writes === 0) {
				return {
					state: advance(taken, {
						reason: 'The new site failed a check before it took any writes.'
					}),
					action: { do: 'reverse' }
				};
			}
			return afterObservation(advance(taken, { needsChoice: state.choice === null }));
		},
		// a check that could not be read never reverses DNS, because the write count is unknown
		'observation-unreadable': (state) => {
			const taken = advance(state, {
				observed: state.observed + 1,
				lastHealthy: false,
				reason: 'The new site could not be checked.'
			});
			return taken.observed >= OBSERVATION_OFFSETS_MS.length
				? { state: { ...taken, state: 'failed' }, action: { do: 'stop' } }
				: { state: taken, action: nextWait(taken) };
		},
		'writes-counted': (state, event) => ({
			state: { ...state, destinationWrites: Math.max(state.destinationWrites, event.writes) },
			action: nextWait(state)
		}),
		'rollback-requested': (state) =>
			state.destinationWrites > 0
				? refuse(state, 'reversal_closed')
				: {
						state: advance(state, { reason: 'The owner asked for a DNS reversal.' }),
						action: { do: 'reverse' }
					},
		'choice-made': (state, event) => {
			if (state.destinationWrites === 0) return refuse(state, 'no_writes_yet');
			if (state.choice !== null) return refuse(state, 'choice_recorded');
			const recorded = advance(state, {
				needsChoice: false,
				choice: {
					value: event.value,
					writesAtChoice: state.destinationWrites,
					recordedAt: need(state.updatedAt, 'event time')
				}
			});
			if (event.value === 'keep-new') return afterObservation(recorded);
			return {
				state: recorded,
				action:
					event.value === 'export-changes' ? { do: 'export-changes' } : { do: 'reverse' }
			};
		},
		'choice-timed-out': (state) => ({
			state: advance(state, {
				state: 'failed',
				reason: 'No choice was recorded. The new site keeps serving and the source is untouched.'
			}),
			action: { do: 'stop' }
		}),
		'changes-exported': (state, event) => ({
			state: advance(state, {
				exportReference: event.reference,
				exportThrough: event.through,
				cannotCarry: event.cannotCarry
			}),
			action: { do: 'reverse' }
		}),
		// an owner who exported has a first file; the address is back, so one more read after old
		// caches expire catches what arrived between the first read and the move
		reversed: (state) =>
			state.exportThrough === null || state.finalChanges !== null
				? { state: advance(state, { state: 'rolled-back' }), action: { do: 'stop' } }
				: {
						state: advance(state, { finalChanges: 'waiting' }),
						action: { do: 'final-changes', since: state.exportThrough }
					},
		'final-changes-exported': (state, event) => ({
			state: advance(state, {
				state: 'rolled-back',
				finalChanges: event.statements === 0 ? 'none' : 'ready',
				finalStatements: event.statements,
				cannotCarry: event.cannotCarry
			}),
			action: { do: 'stop' }
		}),
		'final-changes-unreadable': (state) => ({
			state: advance(state, { state: 'rolled-back', finalChanges: 'unread' }),
			action: { do: 'stop' }
		}),
		finished: (state) => ({
			state: advance(state, { state: 'completed' }),
			action: { do: 'stop' }
		})
	}
};

export function next(state: CutoverState, event: CutoverEvent, at: string): Transition {
	const stamped = { ...state, updatedAt: at };
	if (isTerminal(stamped)) return refuse(stamped, 'finished');
	const key: CutoverStep | 'start' = stamped.step ?? 'start';
	const table = handlers[key] as Table;
	const handler = (table[event.type] ?? common[event.type]) as
		((state: CutoverState, event: CutoverEvent) => Transition) | undefined;
	if (handler === undefined) return refuse(stamped, 'unexpected');
	return handler(stamped, event);
}

// #endregion

// #region what the owner reads

export const cutoverViewSchema = z.object({
	operationId: z.string(),
	siteId: z.string(),
	policy: sourceWritePolicy,
	state: z.enum(CUTOVER_STATES),
	step: cutoverStep.nullable(),
	expectedWindowSeconds: z.int().nonnegative().nullable(),
	snapshotMarker: z.string().nullable(),
	deltaMarker: z.string().nullable(),
	destinationWrites: z.int().nonnegative(),
	choice: z
		.object({
			value: postWriteChoice,
			writesAtChoice: z.int().positive(),
			recordedAt: z.string()
		})
		.nullable(),
	boundary: z.enum(['dns-reversal', 'post-write']),
	needsChoice: z.boolean(),
	observed: z.int().nonnegative(),
	lastHealthy: z.boolean().nullable(),
	exportReference: z.string().nullable(),
	finalChanges: z.enum(FINAL_CHANGES).nullable(),
	finalStatements: z.int().nonnegative(),
	cannotCarry: z.array(z.string()),
	refusal: z.object({ code: z.enum(REFUSAL_CODES), message: z.string() }).nullable(),
	reason: z.string().nullable(),
	sourceDestroyed: z.literal(false),
	updatedAt: z.string().nullable(),
	steps: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			state: z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped'])
		})
	)
});

export type CutoverView = z.infer<typeof cutoverViewSchema>;

export function viewOf(
	operationId: string,
	siteId: string,
	state: CutoverState,
	steps: CutoverView['steps']
): CutoverView {
	return {
		operationId,
		siteId,
		policy: state.policy,
		state: state.state,
		step: state.step,
		expectedWindowSeconds: state.expectedWindowSeconds,
		snapshotMarker: state.snapshotMarker,
		deltaMarker: state.deltaMarker,
		destinationWrites: state.destinationWrites,
		choice: state.choice,
		boundary: boundaryOf(state),
		needsChoice: state.needsChoice,
		observed: state.observed,
		lastHealthy: state.lastHealthy,
		exportReference: state.exportReference,
		finalChanges: state.finalChanges,
		finalStatements: state.finalStatements,
		cannotCarry: state.cannotCarry,
		refusal: state.refusal,
		reason: state.reason,
		sourceDestroyed: false,
		updatedAt: state.updatedAt,
		steps
	};
}

// the cursor holds the state as JSON; one that does not parse is treated as not started
export function readState(cursor: string | null): CutoverState | null {
	if (cursor === null) return null;
	try {
		const parsed = JSON.parse(cursor) as CutoverState;
		return typeof parsed === 'object' && parsed !== null && 'policy' in parsed ? parsed : null;
	} catch {
		return null;
	}
}

// #endregion

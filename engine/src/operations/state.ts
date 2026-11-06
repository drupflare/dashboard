import {
	computePlanDigest,
	DEFAULT_CHANGE_BUDGET,
	planSchema,
	type Operation,
	type OperationType,
	type Plan
} from '@contracts/operations';
import { PermanentError } from '../step';

export type OperationStatus = Operation['status'];
export type OperationStep = Operation['steps'][number];
export type StepState = OperationStep['state'];
export type ChangeBudget = Operation['budget'];
export type BlastRadius = Plan['blastRadius'];

export const OPERATION_ERROR_CODES = [
	'illegal_transition',
	'illegal_step_transition',
	'unknown_step',
	'plan_mismatch',
	'plan_frozen',
	'idempotency_conflict',
	'destructive_budget',
	'deploy_budget',
	'confirmation_required',
	'verification_required',
	'epoch_mismatch',
	'stale_write',
	'not_found'
] as const;
export type OperationErrorCode = (typeof OPERATION_ERROR_CODES)[number];

export class OperationError extends PermanentError {
	declare readonly code: OperationErrorCode;

	constructor(code: OperationErrorCode, message: string) {
		super(code, message);
	}
}

// #region plans

// policy, unreviewed: which operation types count against the destructive and deploy budgets
export const DESTRUCTIVE_TYPES: readonly OperationType[] = [
	'site.delete',
	'site.purge',
	'env.delete',
	'preview.delete',
	'backup.restore'
];

export const DEPLOY_TYPES: readonly OperationType[] = [
	'site.create',
	'site.import',
	'site.upgrade',
	'site.rollback',
	'site.restore',
	'env.promote',
	'fleet.upgrade'
];

export function blastRadiusFor(type: OperationType, targetIds: readonly string[]): BlastRadius {
	const sites = new Set(targetIds).size;
	return {
		sites,
		destructiveSites: DESTRUCTIVE_TYPES.includes(type) ? sites : 0,
		productionDeploys: DEPLOY_TYPES.includes(type) ? sites : 0
	};
}

export interface PlanInput {
	type: OperationType;
	targetIds: string[];
	preconditions: string[];
	steps: { id: string; name: string }[];
	rollbackPoint?: string | null;
}

export function buildPlan(input: PlanInput): Plan {
	return planSchema.parse({
		type: input.type,
		targetIds: input.targetIds,
		preconditions: input.preconditions,
		steps: input.steps,
		blastRadius: blastRadiusFor(input.type, input.targetIds),
		rollbackPoint: input.rollbackPoint ?? null
	});
}

function deepFreeze<T>(value: T): T {
	if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const item of Object.values(value)) deepFreeze(item);
	}
	return value;
}

export interface FrozenPlan {
	plan: Readonly<Plan>;
	planDigest: string;
	fencingEpoch: number;
}

// epoch 0 means no writer lease is bound yet; bindEpoch sets it once
export async function freezePlan(plan: Plan, fencingEpoch = 0): Promise<FrozenPlan> {
	const parsed = planSchema.parse(structuredClone(plan));
	return { plan: deepFreeze(parsed), planDigest: await computePlanDigest(parsed), fencingEpoch };
}

export async function assertPlanMatches(operation: Operation, plan: Plan): Promise<void> {
	if ((await computePlanDigest(plan)) !== operation.planDigest) {
		throw new OperationError(
			'plan_mismatch',
			`the plan differs from the one ${operation.id} froze`
		);
	}
}

// #endregion

// #region creating an operation

const iso = (ms: number) => new Date(ms).toISOString();

export interface NewOperationInput {
	id: string;
	orgId: string;
	idempotencyKey: string;
	frozen: FrozenPlan;
	budget?: ChangeBudget;
	verification?: Operation['verification'];
	now: number;
}

export function newOperation(input: NewOperationInput): Operation {
	const { plan, planDigest, fencingEpoch } = input.frozen;
	return {
		id: input.id,
		orgId: input.orgId,
		type: plan.type,
		status: 'planned',
		idempotencyKey: input.idempotencyKey,
		targetIds: [...plan.targetIds],
		preconditions: [...plan.preconditions],
		planDigest,
		fencingEpoch,
		blastRadius: { ...plan.blastRadius },
		rollbackPoint: plan.rollbackPoint,
		cursor: null,
		steps: plan.steps.map((step) => ({
			id: step.id,
			name: step.name,
			state: 'pending' as const,
			attempt: 0,
			startedAt: null,
			finishedAt: null,
			error: null
		})),
		verification: input.verification ?? 'pending',
		finalObservation: null,
		budget: { ...(input.budget ?? DEFAULT_CHANGE_BUDGET) },
		createdAt: iso(input.now),
		updatedAt: iso(input.now)
	} as Operation;
}

// the same key and the same plan is the same operation; the same key with another plan is a conflict
export function resolveIdempotent(
	existing: Operation | null,
	planDigest: string
): 'create' | 'same' {
	if (existing === null) return 'create';
	if (existing.planDigest !== planDigest) {
		throw new OperationError(
			'idempotency_conflict',
			`the key ${existing.idempotencyKey} belongs to a different plan`
		);
	}
	return 'same';
}

// #endregion

// #region budgets

export const bulkDeleteConfirmation = (count: number) => `delete ${count} sites`;

export function checkBudget(
	blast: BlastRadius,
	budget: ChangeBudget,
	runningProductionDeploys: number
): void {
	if (!budget.elevated && blast.destructiveSites > budget.maxDestructiveSites) {
		throw new OperationError(
			'destructive_budget',
			`${blast.destructiveSites} destructive sites exceed the limit of ${budget.maxDestructiveSites}`
		);
	}
	if (
		blast.destructiveSites > 1 &&
		budget.bulkDeleteConfirmation !== bulkDeleteConfirmation(blast.destructiveSites)
	) {
		throw new OperationError(
			'confirmation_required',
			`a bulk delete needs the typed confirmation "${bulkDeleteConfirmation(blast.destructiveSites)}"`
		);
	}
	if (
		runningProductionDeploys + blast.productionDeploys >
		budget.maxConcurrentProductionDeploys
	) {
		throw new OperationError(
			'deploy_budget',
			`${runningProductionDeploys} deploys are running and the limit is ${budget.maxConcurrentProductionDeploys}`
		);
	}
}

// #endregion

// #region transitions

export const STATUS_TRANSITIONS: Record<OperationStatus, readonly OperationStatus[]> = {
	planned: ['awaiting-approval', 'running', 'cancelled'],
	'awaiting-approval': ['running', 'cancelled'],
	running: ['verifying', 'succeeded', 'failed', 'cancelled'],
	verifying: ['succeeded', 'failed'],
	failed: ['running', 'rolled-back'],
	succeeded: [],
	cancelled: [],
	'rolled-back': []
};

// running to running is a resume after an interruption
export const STEP_TRANSITIONS: Record<StepState, readonly StepState[]> = {
	pending: ['running', 'skipped'],
	running: ['running', 'succeeded', 'failed'],
	failed: ['running', 'skipped'],
	succeeded: [],
	skipped: []
};

export const OPEN_STATUSES: readonly OperationStatus[] = ['running', 'verifying'];

// the version a writer checks: it grows on every change, so a stale copy cannot be saved
function touch(operation: Operation, now: number): string {
	return iso(Math.max(now, Date.parse(operation.updatedAt) + 1));
}

export function transition(operation: Operation, to: OperationStatus, now: number): Operation {
	if (!STATUS_TRANSITIONS[operation.status].includes(to)) {
		throw new OperationError(
			'illegal_transition',
			`${operation.id} cannot move from ${operation.status} to ${to}`
		);
	}
	if (to === 'succeeded' && !['passed', 'not-required'].includes(operation.verification)) {
		throw new OperationError(
			'verification_required',
			`${operation.id} cannot succeed while verification is ${operation.verification}`
		);
	}
	return { ...operation, status: to, updatedAt: touch(operation, now) };
}

export function stepOf(operation: Operation, id: string): OperationStep {
	const found = operation.steps.find((step) => step.id === id);
	if (found === undefined) {
		throw new OperationError('unknown_step', `${operation.id} has no step ${id}`);
	}
	return found;
}

export function transitionStep(
	operation: Operation,
	id: string,
	to: StepState,
	now: number,
	error?: string
): Operation {
	const current = stepOf(operation, id);
	const runnable = OPEN_STATUSES.includes(operation.status);
	if (
		!STEP_TRANSITIONS[current.state].includes(to) ||
		(to !== 'skipped' && !runnable) ||
		(to === 'failed' && !error)
	) {
		throw new OperationError(
			'illegal_step_transition',
			`step ${id} of ${operation.id} cannot move from ${current.state} to ${to} while the operation is ${operation.status}`
		);
	}
	const at = iso(now);
	const next: OperationStep =
		to === 'running'
			? {
					...current,
					state: to,
					attempt: current.attempt + 1,
					startedAt: at,
					finishedAt: null,
					error: null
				}
			: {
					...current,
					state: to,
					finishedAt: at,
					error: to === 'failed' ? (error ?? null) : null
				};
	return {
		...operation,
		steps: operation.steps.map((step) => (step.id === id ? next : step)),
		updatedAt: touch(operation, now)
	};
}

// the step the workflow named, or the plan step that owns it (assets.upload.2 belongs to assets);
// a step cut off before it recorded anything still shows as failed
export function failStep(
	operation: Operation,
	workflowStep: string,
	error: string,
	now: number
): Operation {
	const owner =
		operation.steps.find((step) => step.id === workflowStep) ??
		operation.steps.find((step) => workflowStep.startsWith(`${step.id}.`));
	if (owner === undefined || owner.state === 'failed' || owner.state === 'succeeded') {
		return operation;
	}
	const running =
		owner.state === 'pending' ? transitionStep(operation, owner.id, 'running', now) : operation;
	return transitionStep(running, owner.id, 'failed', now, error);
}

export function skipPending(operation: Operation, now: number): Operation {
	if (!operation.steps.some((step) => step.state === 'pending')) return operation;
	const at = iso(now);
	return {
		...operation,
		steps: operation.steps.map((step) =>
			step.state === 'pending' ? { ...step, state: 'skipped' as const, finishedAt: at } : step
		),
		updatedAt: touch(operation, now)
	};
}

export function setVerification(
	operation: Operation,
	verification: Operation['verification'],
	now: number
): Operation {
	return { ...operation, verification, updatedAt: touch(operation, now) };
}

export function setCursor(operation: Operation, cursor: string | null, now: number): Operation {
	return { ...operation, cursor, updatedAt: touch(operation, now) };
}

export function bindEpoch(operation: Operation, epoch: number, now: number): Operation {
	if (operation.fencingEpoch === epoch) return operation;
	if (operation.fencingEpoch !== 0) {
		throw new OperationError(
			'epoch_mismatch',
			`${operation.id} is fenced at ${operation.fencingEpoch}, not ${epoch}`
		);
	}
	return { ...operation, fencingEpoch: epoch, updatedAt: touch(operation, now) };
}

export function observe(operation: Operation, summary: string, now: number): Operation {
	return {
		...operation,
		finalObservation: { at: iso(now), summary },
		updatedAt: touch(operation, now)
	};
}

// #endregion

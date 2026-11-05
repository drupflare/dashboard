import { z } from 'zod';
import {
	canonicalJson,
	digestSchema,
	isoTimestamp,
	operationId,
	orgId,
	sha256Digest
} from './common';

export const OPERATIONS_VERSION = { major: 1, minor: 0 } as const;

export const OPERATION_TYPES = [
	'site.create',
	'site.adopt',
	'site.import',
	'migration.cutover',
	'estate.assess',
	'site.upgrade',
	'site.rollback',
	'site.delete',
	'site.restore',
	'site.purge',
	'site.transfer',
	'config.apply',
	'git.pull',
	'git.preview',
	'modify.apply',
	'module.install',
	'module.enable',
	'domain.attach',
	'backup.create',
	'backup.verify',
	'backup.restore',
	'backup.export',
	'env.create',
	'env.fork',
	'env.promote',
	'env.delete',
	'preview.create',
	'preview.delete',
	'repair.run',
	'node.pair',
	'node.command',
	'fleet.upgrade',
	'repo.install'
] as const;

export const OPERATION_STATUSES = [
	'planned',
	'awaiting-approval',
	'running',
	'verifying',
	'succeeded',
	'failed',
	'cancelled',
	'rolled-back'
] as const;

export const STEP_STATES = ['pending', 'running', 'succeeded', 'failed', 'skipped'] as const;
export const VERIFICATION_STATES = ['pending', 'passed', 'failed', 'not-required'] as const;

export const operationType = z.enum(OPERATION_TYPES);
export const operationStatus = z.enum(OPERATION_STATUSES);
export const stepState = z.enum(STEP_STATES);
export const verificationState = z.enum(VERIFICATION_STATES);

export const fencingEpoch = z.int().nonnegative();

export const changeBudgetSchema = z.object({
	maxDestructiveSites: z.int().positive(),
	maxConcurrentProductionDeploys: z.int().positive(),
	elevated: z.boolean(),
	bulkDeleteConfirmation: z.string().nullable()
});

export const DEFAULT_CHANGE_BUDGET = {
	maxDestructiveSites: 5,
	maxConcurrentProductionDeploys: 10,
	elevated: false,
	bulkDeleteConfirmation: null
} as const satisfies z.infer<typeof changeBudgetSchema>;

export const blastRadiusSchema = z.object({
	sites: z.int().nonnegative(),
	destructiveSites: z.int().nonnegative(),
	productionDeploys: z.int().nonnegative()
});

export const planStepSchema = z.object({
	id: z.string().min(1).max(64),
	name: z.string().min(1).max(200)
});

export const planSchema = z.object({
	type: operationType,
	targetIds: z.array(z.string().min(1)),
	preconditions: z.array(z.string()),
	steps: z.array(planStepSchema).min(1),
	blastRadius: blastRadiusSchema,
	rollbackPoint: z.string().nullable()
});

export const stepSchema = z.object({
	id: z.string().min(1).max(64),
	name: z.string().min(1).max(200),
	state: stepState,
	attempt: z.int().nonnegative(),
	startedAt: isoTimestamp.nullable(),
	finishedAt: isoTimestamp.nullable(),
	error: z.string().nullable()
});

export const finalObservationSchema = z.object({
	at: isoTimestamp,
	summary: z.string()
});

export const operationSchema = z.object({
	id: operationId,
	orgId,
	type: operationType,
	status: operationStatus,
	idempotencyKey: z.string().min(1).max(128),
	targetIds: z.array(z.string().min(1)),
	preconditions: z.array(z.string()),
	planDigest: digestSchema,
	fencingEpoch,
	blastRadius: blastRadiusSchema,
	rollbackPoint: z.string().nullable(),
	cursor: z.string().nullable(),
	steps: z.array(stepSchema),
	verification: verificationState,
	finalObservation: finalObservationSchema.nullable(),
	budget: changeBudgetSchema,
	createdAt: isoTimestamp,
	updatedAt: isoTimestamp
});

export type OperationType = z.infer<typeof operationType>;
export type Plan = z.infer<typeof planSchema>;
export type Operation = z.infer<typeof operationSchema>;

export async function computePlanDigest(plan: Plan): Promise<string> {
	return sha256Digest(canonicalJson(planSchema.parse(plan)));
}

export const schemas = {
	changeBudget: changeBudgetSchema,
	plan: planSchema,
	step: stepSchema,
	operation: operationSchema
};

import {
	assessmentState,
	CMS_VALUES,
	ESTATE_LIMITS,
	findingSchema,
	reportSchema,
	rowClass,
	rowState
} from '@contracts/estate';
import { z } from 'zod';

export const ASSESSMENT_ID = /^asm_[a-z0-9]{26}$/;

export const rejectedRowSchema = z.object({ line: z.int().positive(), reason: z.string() });

export const checkViewSchema = z.object({
	fileError: z.string().nullable(),
	rows: z.int().nonnegative(),
	sites: z.int().nonnegative(),
	notReconciled: z.int().nonnegative(),
	rejected: z.array(rejectedRowSchema),
	rejectedTotal: z.int().nonnegative(),
	ignoredColumns: z.array(z.string())
});

export const assessmentViewSchema = z.object({
	id: z.string(),
	operationId: z.string(),
	state: assessmentState,
	rowCount: z.int().nonnegative(),
	rejectedTotal: z.int().nonnegative(),
	// rows by state, so the page can show how far the run has come
	progress: z.record(rowState, z.int().nonnegative()),
	classes: z.record(rowClass, z.int().nonnegative()),
	report: reportSchema.nullable(),
	createdAt: z.string(),
	updatedAt: z.string()
});

export const rowViewSchema = z.object({
	number: z.int().positive(),
	hostname: z.string(),
	aliases: z.array(z.string()),
	server: z.string(),
	cms: z.enum(CMS_VALUES),
	version: z.string(),
	class: rowClass.nullable(),
	state: rowState,
	basis: z.string().nullable(),
	reconciled: z.boolean(),
	missing: z.string().nullable(),
	findings: z.array(findingSchema)
});

export const proofViewSchema = z.object({
	domain: z.string(),
	proven: z.boolean(),
	record: z.object({ type: z.literal('TXT'), name: z.string(), value: z.string() }),
	file: z.object({ path: z.string(), content: z.string() })
});

export const proofCheckSchema = z.object({
	domain: z.string(),
	proven: z.boolean(),
	method: z.enum(['dns', 'http']),
	detail: z.string()
});

export const createBodySchema = z.strictObject({
	text: z.string().min(1).max(ESTATE_LIMITS.textBytes),
	// import keys whose servers the survey may read; each needs a confirmed host key
	credentialIds: z
		.array(z.string().regex(/^imc_[a-z2-7]{26}$/))
		.max(20)
		.optional()
});

export const checkBodySchema = z.strictObject({
	text: z.string().max(ESTATE_LIMITS.textBytes)
});

export const proofBodySchema = z.strictObject({
	domain: z.string().min(3).max(ESTATE_LIMITS.hostnameChars)
});

export const proofCheckBodySchema = z.strictObject({
	domain: z.string().min(3).max(ESTATE_LIMITS.hostnameChars),
	method: z.enum(['dns', 'http'])
});

export type AssessmentView = z.infer<typeof assessmentViewSchema>;
export type RowView = z.infer<typeof rowViewSchema>;
export type CheckView = z.infer<typeof checkViewSchema>;
export type ProofView = z.infer<typeof proofViewSchema>;
export type ProofCheck = z.infer<typeof proofCheckSchema>;

export const CLASS_LABELS: Record<z.infer<typeof rowClass>, string> = {
	ready: 'Ready',
	'automatic upgrade': 'Automatic Upgrade',
	'needs decision': 'Needs Decision',
	unsupported: 'Unsupported',
	information: 'Information'
};

export const STATE_LABELS: Record<z.infer<typeof rowState>, string> = {
	pending: 'Waiting',
	checking: 'Checking',
	done: 'Checked',
	'needs access': 'Needs Access',
	'needs proof': 'Needs Proof',
	'could not check': 'Could Not Check',
	skipped: 'Skipped'
};

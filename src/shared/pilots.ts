import { z } from 'zod';

export const PILOT_STATES = ['planned', 'running', 'decided'] as const;
export const PILOT_DECISIONS = ['continue', 'extend', 'stop'] as const;
export const OBSERVATION_KINDS = [
	'exception',
	'failure',
	'unsupported',
	'manual-work',
	'note'
] as const;

export type PilotState = (typeof PILOT_STATES)[number];
export type PilotDecision = (typeof PILOT_DECISIONS)[number];
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-03-01');
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const nullableNumber = (max: number) => z.number().nonnegative().max(max).nullable().optional();

export const pilotBodySchema = z.object({
	name: z.string().trim().min(1).max(120),
	startDate: day,
	sponsor: nullableText(200),
	technicalOwner: nullableText(200),
	baselineHostingSpendCents: z.number().int().nonnegative().max(1e9).nullable().optional(),
	baselineStaffHours: nullableNumber(100_000),
	baselineLatencyMs: nullableNumber(60_000),
	baselineRestoreMinutes: nullableNumber(100_000),
	baselineRollbackMinutes: nullableNumber(100_000),
	baselinePatchDays: nullableNumber(3650),
	successCriteria: z.string().trim().max(2000).optional()
});

export type PilotBody = z.infer<typeof pilotBodySchema>;

export const pilotPatchSchema = pilotBodySchema.partial();

export const pilotViewSchema = z.object({
	id: z.string(),
	name: z.string(),
	state: z.enum(PILOT_STATES),
	startDate: z.string(),
	sponsor: z.string().nullable(),
	technicalOwner: z.string().nullable(),
	baselineHostingSpendCents: z.number().nullable(),
	baselineStaffHours: z.number().nullable(),
	baselineLatencyMs: z.number().nullable(),
	baselineRestoreMinutes: z.number().nullable(),
	baselineRollbackMinutes: z.number().nullable(),
	baselinePatchDays: z.number().nullable(),
	successCriteria: z.string(),
	decision: z.enum(PILOT_DECISIONS).nullable(),
	decidedAt: z.string().nullable(),
	continuationCostCents: z.number().nullable(),
	siteIds: z.array(z.string()),
	createdAt: z.string()
});

export type PilotView = z.infer<typeof pilotViewSchema>;

export const pilotSitesBodySchema = z.object({ siteIds: z.array(z.string().min(1)).max(500) });

export const observationBodySchema = z.object({
	kind: z.enum(OBSERVATION_KINDS),
	at: z.string().datetime().optional(),
	minutes: z.number().int().nonnegative().max(100_000).nullable().optional(),
	text: z.string().trim().min(1).max(2000)
});

export type ObservationBody = z.infer<typeof observationBodySchema>;

export const observationViewSchema = z.object({
	id: z.string(),
	at: z.string(),
	kind: z.enum(OBSERVATION_KINDS),
	minutes: z.number().nullable(),
	text: z.string()
});

export const decisionBodySchema = z.object({
	decision: z.enum(PILOT_DECISIONS),
	continuationCostCents: z.number().int().nonnegative().max(1e9).nullable().optional()
});

export type DecisionBody = z.infer<typeof decisionBodySchema>;

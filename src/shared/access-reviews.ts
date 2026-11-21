import { z } from 'zod';

export const REVIEW_ITEM_KINDS = [
	'member',
	'grant',
	'delegation',
	'api-key',
	'service-account'
] as const;
export type ReviewItemKind = (typeof REVIEW_ITEM_KINDS)[number];

export const REVIEW_DECISIONS = ['pending', 'keep', 'revoke'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const REVIEW_STATES = ['open', 'closed'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const STALE_DAYS = 90;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const REVIEW_DUE_DAYS = 30;

export const REVIEW_INTERVALS = ['off', 'quarterly', 'yearly'] as const;
export type ReviewInterval = (typeof REVIEW_INTERVALS)[number];

export const REVIEW_INTERVAL_DAYS: Record<ReviewInterval, number | null> = {
	off: null,
	quarterly: 91,
	yearly: 365
};

export const REVIEW_INTERVAL_LABEL: Record<ReviewInterval, string> = {
	off: 'Off',
	quarterly: 'Every Quarter',
	yearly: 'Every Year'
};

export const REVIEW_KIND_LABEL: Record<ReviewItemKind, string> = {
	member: 'Member',
	grant: 'Access Grant',
	delegation: 'Agency Access',
	'api-key': 'API Key',
	'service-account': 'Service Account'
};

export const REVIEW_DECISION_LABEL: Record<ReviewDecision, string> = {
	pending: 'Waiting',
	keep: 'Keep',
	revoke: 'Remove'
};

export const reviewCreateBodySchema = z.strictObject({
	// "organization" or a department id
	scope: z.string().min(1).max(64),
	dueInDays: z.number().int().min(1).max(365).optional()
});
export type ReviewCreateBody = z.infer<typeof reviewCreateBodySchema>;

export const reviewDecideBodySchema = z.strictObject({
	kind: z.enum(REVIEW_ITEM_KINDS),
	subjectRef: z.string().min(1).max(200),
	decision: z.enum(['keep', 'revoke']),
	reason: z.string().trim().max(500).optional(),
	applyNow: z.boolean().optional()
});
export type ReviewDecideBody = z.infer<typeof reviewDecideBodySchema>;

export const reviewScheduleBodySchema = z.strictObject({ interval: z.enum(REVIEW_INTERVALS) });
export type ReviewScheduleBody = z.infer<typeof reviewScheduleBodySchema>;

export const reviewScheduleViewSchema = z.strictObject({
	interval: z.enum(REVIEW_INTERVALS),
	lastOpenedAt: z.string().nullable()
});
export type ReviewScheduleView = z.infer<typeof reviewScheduleViewSchema>;

export const reviewViewSchema = z.strictObject({
	id: z.string(),
	scope: z.string(),
	scopeName: z.string(),
	state: z.enum(REVIEW_STATES),
	dueAt: z.string(),
	createdBy: z.string(),
	createdAt: z.string(),
	closedAt: z.string().nullable(),
	total: z.number().int(),
	pending: z.number().int(),
	keep: z.number().int(),
	revoke: z.number().int()
});
export type ReviewView = z.infer<typeof reviewViewSchema>;

export const reviewListSchema = z.strictObject({ items: z.array(reviewViewSchema) });
export type ReviewList = z.infer<typeof reviewListSchema>;

export const reviewItemViewSchema = z.strictObject({
	kind: z.enum(REVIEW_ITEM_KINDS),
	subjectRef: z.string(),
	label: z.string(),
	detail: z.string(),
	heldBy: z.string().nullable(),
	decision: z.enum(REVIEW_DECISIONS),
	decidedBy: z.string().nullable(),
	decidedAt: z.string().nullable(),
	reason: z.string().nullable(),
	appliedAt: z.string().nullable(),
	applyError: z.string().nullable(),
	// the signed-in person is the subject, so someone else has to decide
	own: z.boolean()
});
export type ReviewItemView = z.infer<typeof reviewItemViewSchema>;

export const reviewDetailSchema = reviewViewSchema.extend({
	items: z.array(reviewItemViewSchema),
	// a department admin sees only the items they can decide, and the counts cover those items
	limited: z.boolean()
});
export type ReviewDetail = z.infer<typeof reviewDetailSchema>;

export const staleRowSchema = z.strictObject({
	kind: z.enum(['api-key', 'service-account', 'grant']),
	subjectRef: z.string(),
	label: z.string(),
	// null: nothing recorded
	lastUsedAt: z.string().nullable(),
	since: z.string(),
	days: z.number().int()
});
export type StaleRow = z.infer<typeof staleRowSchema>;

export const staleReportSchema = z.strictObject({
	days: z.number().int(),
	items: z.array(staleRowSchema)
});
export type StaleReport = z.infer<typeof staleReportSchema>;

export const closeResultSchema = z.strictObject({
	review: reviewViewSchema,
	applied: z.number().int(),
	failed: z.number().int()
});
export type CloseResult = z.infer<typeof closeResultSchema>;

export const evidenceJsonSchema = z.strictObject({
	review: reviewViewSchema,
	items: z.array(reviewItemViewSchema),
	sha256: z.string()
});
export type EvidenceJson = z.infer<typeof evidenceJsonSchema>;

export const EVIDENCE_COLUMNS = [
	'Type',
	'Subject',
	'Held By',
	'Detail',
	'Decision',
	'Decided By',
	'Decided At',
	'Reason',
	'Applied At',
	'Not Applied Because'
] as const;

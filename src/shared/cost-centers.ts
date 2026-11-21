import { z } from 'zod';

export const COST_CENTER_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export const ACCOUNTING_STATES = ['exact', 'estimated', 'unaccounted'] as const;
export type AccountingState = (typeof ACCOUNTING_STATES)[number];

export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const costCenterBodySchema = z.object({
	code: z
		.string()
		.trim()
		.regex(COST_CENTER_CODE, 'Use 1 to 32 letters, numbers, dots, dashes or underscores'),
	name: z.string().trim().min(1).max(120),
	departmentId: z.string().trim().min(1).max(64).nullable().optional(),
	ownerContact: z.string().trim().max(200).nullable().optional()
});

export type CostCenterBody = z.infer<typeof costCenterBodySchema>;

export const costCenterViewSchema = z.object({
	id: z.string().min(1),
	code: z.string(),
	name: z.string(),
	departmentId: z.string().nullable(),
	ownerContact: z.string().nullable(),
	createdAt: z.string()
});

export type CostCenterView = z.infer<typeof costCenterViewSchema>;

export const assignSiteBodySchema = z.object({
	costCenterId: z.string().min(1).nullable(),
	technicalOwner: z.string().trim().max(200).nullable().optional(),
	businessOwner: z.string().trim().max(200).nullable().optional()
});

export type AssignSiteBody = z.infer<typeof assignSiteBodySchema>;

export const costReportRowSchema = z.object({
	costCenterId: z.string(),
	code: z.string(),
	name: z.string(),
	siteCount: z.number().int().nonnegative(),
	views: z.number().int().nonnegative(),
	state: z.enum(ACCOUNTING_STATES),
	allocatedCents: z.number().int().nonnegative().nullable(),
	share: z.number().min(0).max(1).nullable(),
	projectedViews: z.number().int().nonnegative().nullable()
});

export const costReportSchema = z.object({
	month: z.string().regex(MONTH),
	method: z.literal('straight-line'),
	amountCents: z.number().int().nonnegative().nullable(),
	rows: z.array(costReportRowSchema),
	central: z.object({
		costCenters: z.number().int().nonnegative(),
		sites: z.number().int().nonnegative(),
		unassignedSites: z.number().int().nonnegative(),
		views: z.number().int().nonnegative(),
		state: z.enum(ACCOUNTING_STATES)
	})
});

export type CostReport = z.infer<typeof costReportSchema>;
export type CostReportRow = z.infer<typeof costReportRowSchema>;

export const costSiteSchema = z.object({
	id: z.string(),
	name: z.string(),
	costCenterId: z.string().nullable()
});

export type CostSite = z.infer<typeof costSiteSchema>;

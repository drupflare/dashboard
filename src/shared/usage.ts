import { z } from 'zod';

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export const ACCOUNTING_STATES = ['exact', 'estimated', 'unaccounted'] as const;
export const accountingSchema = z.enum(ACCOUNTING_STATES);
export type Accounting = z.infer<typeof accountingSchema>;

export const ACCOUNTING_LABELS: Record<Accounting, string> = {
	exact: 'Exact',
	estimated: 'Estimated',
	unaccounted: 'Not Recorded'
};

export interface UsageBar {
	label: string;
	value: number;
	state: Accounting;
}

export interface UsageTableRow {
	label: string;
	views: number;
	lowerBound: number;
	state: Accounting;
}

const count = z.int().nonnegative();

export const monthViewSchema = z.object({
	views: count,
	lowerBound: count,
	state: accountingSchema,
	closed: z.boolean(),
	expectedHours: count,
	presentHours: count
});

export const dayViewSchema = z.object({
	day: z.string(),
	views: count,
	lowerBound: count,
	state: accountingSchema,
	unaccountedHours: count
});

export const siteUsageSchema = monthViewSchema.extend({
	siteId: z.string(),
	name: z.string(),
	days: z.array(dayViewSchema)
});

export const orgUsageSchema = z.object({
	month: z.string(),
	allowance: z.object({ views: count.nullable(), pooled: z.boolean() }),
	total: monthViewSchema,
	days: z.array(dayViewSchema),
	sites: z.array(siteUsageSchema)
});

export const siteMonthUsageSchema = siteUsageSchema.omit({ name: true });

export type MonthView = z.infer<typeof monthViewSchema>;
export type DayView = z.infer<typeof dayViewSchema>;
export type SiteUsage = z.infer<typeof siteUsageSchema>;
export type OrgUsage = z.infer<typeof orgUsageSchema>;
export type SiteMonthUsage = z.infer<typeof siteMonthUsageSchema>;

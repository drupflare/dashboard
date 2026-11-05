import { z } from 'zod';
import { isoTimestamp, siteId } from './common';

export const USAGE_VERSION = { major: 1, minor: 0 } as const;

export const VIEW_ACCURACIES = ['exact', 'estimated', 'unaccounted'] as const;
export const SETTLEMENT_STATES = ['open', 'closed', 'invoiced', 'adjusted'] as const;
export const USAGE_SOURCES = ['dispatch', 'worker', 'node'] as const;

const HOUR_MS = 3_600_000;

export const viewAccuracy = z.enum(VIEW_ACCURACIES);
export const settlementState = z.enum(SETTLEMENT_STATES);
export const usageSource = z.enum(USAGE_SOURCES);

export const usageIntervalSchema = z
	.object({
		siteId,
		start: isoTimestamp,
		end: isoTimestamp,
		accuracy: viewAccuracy,
		views: z.int().nonnegative(),
		lowerBound: z.int().nonnegative(),
		observedViews: z.int().nonnegative().nullable(),
		settlement: settlementState
	})
	.refine((i) => Date.parse(i.end) - Date.parse(i.start) === HOUR_MS, {
		message: 'an interval is one hour',
		path: ['end']
	})
	.refine(
		(i) =>
			i.accuracy === 'exact'
				? i.lowerBound === i.views
				: i.accuracy === 'estimated'
					? i.lowerBound <= i.views
					: i.lowerBound === 0,
		{ message: 'lowerBound does not match accuracy', path: ['lowerBound'] }
	);

export const usageReportSchema = z.object({
	reportId: z.string().min(8).max(64),
	source: usageSource,
	sentAt: isoTimestamp,
	intervals: z.array(usageIntervalSchema).min(1).max(1000)
});

export const usageAdjustmentSchema = z.object({
	id: z.string().min(8).max(64),
	siteId,
	intervalStart: isoTimestamp,
	delta: z.int().refine((n) => n !== 0, { message: 'delta must not be zero' }),
	reason: z.string().min(1).max(500),
	invoiceRef: z.string().nullable(),
	at: isoTimestamp
});

export type UsageInterval = z.infer<typeof usageIntervalSchema>;
export type UsageReport = z.infer<typeof usageReportSchema>;

// free-tier enforcement reads the lower bound, and an unaccounted interval counts for nothing
export function enforcementViews(interval: UsageInterval): number {
	return interval.accuracy === 'unaccounted' ? 0 : interval.lowerBound;
}

export const schemas = {
	usageInterval: usageIntervalSchema,
	usageReport: usageReportSchema,
	usageAdjustment: usageAdjustmentSchema
};

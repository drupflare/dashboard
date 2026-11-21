import { z } from 'zod';

export const budgetBodySchema = z.strictObject({
	percent: z.number(),
	enforcement: z.enum(['block', 'alert'])
});
export type BudgetBody = z.infer<typeof budgetBodySchema>;

const moneySchema = z.union([
	z.object({ kind: z.literal('dollars'), dollars: z.number() }),
	z.object({
		kind: z.literal('unreviewed'),
		reason: z.enum(['rate-unknown', 'rate-unreviewed', 'allowance-unknown'])
	})
]);

const ALERT_KEYS = [
	'allowance-75',
	'allowance-90',
	'allowance-100',
	'allowance-250',
	'budget-90',
	'blocked'
] as const;

export const budgetViewSchema = z.object({
	status: z.literal('ok'),
	scope: z.enum(['org', 'site']),
	siteId: z.string().nullable(),
	percent: z.number().nullable(),
	enforcement: z.enum(['block', 'alert']).nullable(),
	ownerSet: z.boolean(),
	allowanceViews: z.number().nullable(),
	dollars: moneySchema.nullable(),
	viewsLowerBound: z.number().nullable(),
	accounting: z.enum(['counted', 'unavailable']),
	state: z.enum(['ok', 'over-budget', 'would-block']),
	flags: z.array(z.enum(['count-unknown', 'allowance-unknown', 'would-block'])),
	alertsSent: z.array(z.enum(ALERT_KEYS)),
	enforcementFlag: z.enum(['shadow', 'on']),
	overageBilled: z.boolean(),
	appliesWithin: z.string()
});

export const budgetReplySchema = z.union([
	budgetViewSchema,
	z.object({ status: z.literal('not_applicable') })
]);

export const budgetWriteReplySchema = z.union([
	budgetViewSchema.extend({ changed: z.boolean() }),
	z.object({ status: z.literal('not_applicable') })
]);

export type BudgetView = z.infer<typeof budgetViewSchema>;
export type BudgetReply = z.infer<typeof budgetReplySchema>;
export type BudgetWriteReply = z.infer<typeof budgetWriteReplySchema>;

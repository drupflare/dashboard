import { z } from 'zod';

export const PROCUREMENT_KINDS = ['quote', 'po', 'invoice', 'contract'] as const;
export type ProcurementKind = (typeof PROCUREMENT_KINDS)[number];

export const PROCUREMENT_KIND_LABELS: Record<ProcurementKind, string> = {
	quote: 'Quote',
	po: 'Purchase Order',
	invoice: 'Invoice',
	contract: 'Contract'
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// the amount is free text as the buyer wrote it; nothing here parses or totals it
export const procurementBodySchema = z.strictObject({
	kind: z.enum(PROCUREMENT_KINDS),
	reference: z.string().trim().min(1).max(120),
	signatory: z.string().trim().max(160).optional(),
	amount: z.string().trim().max(64).optional(),
	issuedOn: z.string().regex(DATE).optional(),
	dueOn: z.string().regex(DATE).optional(),
	notes: z.string().trim().max(2000).optional()
});
export type ProcurementBody = z.infer<typeof procurementBodySchema>;

export const procurementViewSchema = z.object({
	id: z.string(),
	kind: z.enum(PROCUREMENT_KINDS),
	reference: z.string(),
	signatory: z.string().nullable(),
	amount: z.string().nullable(),
	issuedOn: z.string().nullable(),
	dueOn: z.string().nullable(),
	notes: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string()
});
export type ProcurementView = z.infer<typeof procurementViewSchema>;

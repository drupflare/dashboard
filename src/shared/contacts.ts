import { z } from 'zod';

export const CONTACT_ROLES = ['technical', 'billing', 'legal', 'recovery'] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];

export const CONTACT_ROLE_LABELS: Record<ContactRole, string> = {
	technical: 'Technical',
	billing: 'Billing',
	legal: 'Legal',
	recovery: 'Recovery'
};

// the verification link lasts this long
export const CONTACT_VERIFY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const contactBodySchema = z.strictObject({
	name: z.string().trim().min(1).max(120),
	email: z.email().max(254),
	notifyOn: z.boolean()
});
export type ContactBody = z.infer<typeof contactBodySchema>;

export const contactViewSchema = z.object({
	role: z.enum(CONTACT_ROLES),
	name: z.string(),
	email: z.string(),
	verifiedAt: z.string().nullable(),
	notifyOn: z.boolean(),
	updatedAt: z.string()
});
export type ContactView = z.infer<typeof contactViewSchema>;

export const contactConfirmSchema = z.strictObject({
	token: z.string().min(20).max(200)
});

export const testResultSchema = z.object({
	sent: z.boolean(),
	message: z.string()
});
export type TestResult = z.infer<typeof testResultSchema>;

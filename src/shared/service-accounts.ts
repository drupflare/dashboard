import { z } from 'zod';
import { keyViewSchema } from './api-keys';

export const SERVICE_ACCOUNT_MAX_DAYS = 365;
export const SERVICE_ACCOUNT_MAX_MS = SERVICE_ACCOUNT_MAX_DAYS * 24 * 60 * 60 * 1000;

export const serviceAccountCreateBodySchema = z.strictObject({
	name: z.string().trim().min(1).max(80),
	departmentId: z.string().min(1).max(64).nullable().optional(),
	// defaults to the person creating the account
	ownerUserId: z.string().min(1).max(64).optional(),
	expiresInDays: z.number().int().min(1).max(SERVICE_ACCOUNT_MAX_DAYS)
});
export type ServiceAccountCreateBody = z.infer<typeof serviceAccountCreateBodySchema>;

export const SERVICE_ACCOUNT_STATES = ['active', 'expired', 'disabled'] as const;
export type ServiceAccountState = (typeof SERVICE_ACCOUNT_STATES)[number];

export const serviceAccountViewSchema = z.strictObject({
	id: z.string(),
	name: z.string(),
	departmentId: z.string().nullable(),
	ownerUserId: z.string(),
	ownerEmail: z.string().nullable(),
	state: z.enum(SERVICE_ACCOUNT_STATES),
	expiresAt: z.string(),
	disabledAt: z.string().nullable(),
	createdAt: z.string(),
	keyCount: z.number().int(),
	lastUsedAt: z.string().nullable()
});
export type ServiceAccountView = z.infer<typeof serviceAccountViewSchema>;

export const serviceAccountListSchema = z.strictObject({
	items: z.array(serviceAccountViewSchema)
});
export type ServiceAccountList = z.infer<typeof serviceAccountListSchema>;

export const serviceAccountKeyListSchema = z.strictObject({ items: z.array(keyViewSchema) });
export type ServiceAccountKeyList = z.infer<typeof serviceAccountKeyListSchema>;

export const SERVICE_ACCOUNT_STATE_LABEL: Record<ServiceAccountState, string> = {
	active: 'Active',
	expired: 'Expired',
	disabled: 'Disabled'
};

export function serviceAccountStateOf(
	account: { expiresAt: number; disabledAt: number | null },
	now: number
): ServiceAccountState {
	if (account.disabledAt !== null) return 'disabled';
	return account.expiresAt <= now ? 'expired' : 'active';
}

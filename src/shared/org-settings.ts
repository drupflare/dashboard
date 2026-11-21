import { z } from 'zod';

export const ORG_SETTING_KEYS = {
	departmentAdminsDecideReviews: 'review.department-admins-decide'
} as const;

// a missing row means the default
export const ORG_SETTING_DEFAULTS = { departmentAdminsDecideReviews: true } as const;

export const orgSettingsSchema = z.strictObject({ departmentAdminsDecideReviews: z.boolean() });
export type OrgSettings = z.infer<typeof orgSettingsSchema>;

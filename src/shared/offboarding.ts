import { z } from 'zod';

export const offboardBodySchema = z.strictObject({
	dryRun: z.boolean().optional(),
	// takes the service accounts; without one they are disabled
	transferTo: z.string().min(1).max(64).optional(),
	// leave the agency access this person created in place
	keepDelegations: z.boolean().optional()
});
export type OffboardBody = z.infer<typeof offboardBodySchema>;

export const OFFBOARD_EFFECT_KINDS = [
	'membership',
	'department-role',
	'site-grant',
	'delegation',
	'api-key',
	'service-account-transfer',
	'service-account-disable',
	'invite',
	'review-item'
] as const;
export type OffboardEffectKind = (typeof OFFBOARD_EFFECT_KINDS)[number];

export const OFFBOARD_EFFECT_LABEL: Record<OffboardEffectKind, string> = {
	membership: 'Remove from the organization',
	'department-role': 'Remove a department role',
	'site-grant': 'Remove access to a site',
	delegation: 'End agency access they created',
	'api-key': 'Revoke an API key',
	'service-account-transfer': 'Hand a service account to the new owner',
	'service-account-disable': 'Disable a service account',
	invite: 'Cancel an invitation they sent',
	'review-item': 'Take them off an open review'
};

export const offboardEffectSchema = z.strictObject({
	kind: z.enum(OFFBOARD_EFFECT_KINDS),
	ref: z.string(),
	label: z.string()
});
export type OffboardEffect = z.infer<typeof offboardEffectSchema>;

export const offboardResultSchema = z.strictObject({
	dryRun: z.boolean(),
	userId: z.string(),
	email: z.string().nullable(),
	effects: z.array(offboardEffectSchema),
	// delegations the person created and an admin chose to keep
	kept: z.array(offboardEffectSchema)
});
export type OffboardResult = z.infer<typeof offboardResultSchema>;

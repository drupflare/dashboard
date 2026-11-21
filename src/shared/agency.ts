import { isoTimestamp, siteId } from '@contracts/common';
import { z } from 'zod';

export const DELEGATION_ROLES = ['maintainer', 'viewer'] as const;
export const DELEGATION_VIEW_STATES = ['pending', 'active', 'revoked', 'expired'] as const;
export const TRANSFER_VIEW_STATES = [
	'proposed',
	'accepted',
	'completing',
	'failed',
	'declined',
	'cancelled',
	'completed',
	'expired'
] as const;

export const delegationRole = z.enum(DELEGATION_ROLES);

export const delegationCreateSchema = z.strictObject({
	agencyOrganizationId: z.string().min(1).max(64),
	role: delegationRole,
	sites: z.union([z.literal('all'), z.array(siteId).min(1).max(200)]),
	expiresAt: isoTimestamp.nullable().optional()
});
export type DelegationCreate = z.infer<typeof delegationCreateSchema>;

// one delegation is a batch of rows, one per site, or one row for every site
export const delegationViewSchema = z.object({
	id: z.string().min(1),
	clientOrganizationId: z.string().min(1),
	agencyOrganizationId: z.string().min(1),
	role: delegationRole,
	sites: z.union([z.literal('all'), z.array(z.string())]),
	state: z.enum(DELEGATION_VIEW_STATES),
	createdBy: z.string().min(1),
	createdAt: isoTimestamp,
	expiresAt: isoTimestamp.nullable(),
	revokedAt: isoTimestamp.nullable()
});
export type DelegationView = z.infer<typeof delegationViewSchema>;

export const delegationListSchema = z.object({
	sent: z.array(delegationViewSchema),
	received: z.array(delegationViewSchema)
});
export type DelegationList = z.infer<typeof delegationListSchema>;

export const transferCreateSchema = z.strictObject({
	toOrganizationId: z.string().min(1).max(64),
	keepDelegationId: z.string().min(1).max(64).nullable().optional()
});
export type TransferCreate = z.infer<typeof transferCreateSchema>;

export const transferViewSchema = z.object({
	id: z.string().min(1),
	siteId: z.string().min(1),
	fromOrganizationId: z.string().min(1),
	toOrganizationId: z.string().min(1),
	state: z.enum(TRANSFER_VIEW_STATES),
	keepDelegationId: z.string().nullable(),
	proposedAt: isoTimestamp,
	expiresAt: isoTimestamp,
	decidedAt: isoTimestamp.nullable(),
	// the handover running or last run, once the receiving owner started it
	operationId: z.string().nullable().optional(),
	// plain words for a handover that stopped; absent otherwise
	failureReason: z.string().nullable().optional()
});
export type TransferView = z.infer<typeof transferViewSchema>;

export const transferListSchema = z.object({
	outgoing: z.array(transferViewSchema),
	incoming: z.array(transferViewSchema)
});
export type TransferList = z.infer<typeof transferListSchema>;

const note = z.string().trim().max(2000);

export const clientBodySchema = z.strictObject({
	name: z.string().trim().min(1).max(100),
	contactName: z.string().trim().max(100).nullable().optional(),
	contactEmail: z.email().max(254).nullable().optional(),
	notes: note.nullable().optional(),
	contractNotes: note.nullable().optional()
});
export type ClientBody = z.infer<typeof clientBodySchema>;

export const clientViewSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	contactName: z.string().nullable(),
	contactEmail: z.string().nullable(),
	notes: z.string().nullable(),
	contractNotes: z.string().nullable(),
	siteIds: z.array(z.string()),
	createdAt: isoTimestamp,
	updatedAt: isoTimestamp
});
export type ClientView = z.infer<typeof clientViewSchema>;

export const clientListSchema = z.object({ items: z.array(clientViewSchema) });

export const deletedSchema = z.strictObject({ deleted: z.literal(true) });

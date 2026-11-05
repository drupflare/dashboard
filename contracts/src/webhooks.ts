import { z } from 'zod';
import { isoTimestamp, operationId, orgId, siteId } from './common';
import { operationStatus, operationType } from './operations';
import { siteState } from './sites';

export const WEBHOOKS_VERSION = { major: 1, minor: 0 } as const;
export const WEBHOOKS_CONTRACT = 'webhooks';

const event = <T extends string, D extends z.ZodType>(type: T, data: D) =>
	z.object({
		v: z.literal(WEBHOOKS_VERSION.major),
		id: z.string().min(8).max(64),
		type: z.literal(type),
		createdAt: isoTimestamp,
		orgId,
		data
	});

export const webhookEventSchema = z.discriminatedUnion('type', [
	event(
		'operation.succeeded',
		z.object({ opId: operationId, operationType, status: operationStatus })
	),
	event(
		'operation.failed',
		z.object({ opId: operationId, operationType, status: operationStatus, reason: z.string() })
	),
	event('site.state.changed', z.object({ siteId, from: siteState, to: siteState })),
	event(
		'backup.verified',
		z.object({ siteId, backupId: z.string().min(1), verified: z.boolean() })
	),
	event(
		'release.published',
		z.object({ releaseId: z.string().min(1), version: z.string().min(1) })
	)
]);

export type WebhookEvent = z.infer<typeof webhookEventSchema>;

export const schemas = { webhookEvent: webhookEventSchema };

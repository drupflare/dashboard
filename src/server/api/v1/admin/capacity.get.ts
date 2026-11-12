import { z } from 'zod';
import type { CapacityView } from '../../../../shared/capacity';
import { readCapacity } from '../../../services/capacity';
import { defineApi } from '../../../utils/define-api';

const count = z.number().int().nonnegative();
const cents = z.number().int();
const text = z.string();

const credits = z.discriminatedUnion('state', [
	z.object({
		state: z.literal('ok'),
		currency: text,
		balanceCents: cents,
		originalCents: cents,
		usedCents: cents,
		daysRemaining: z.number().nullable(),
		validFrom: text.nullable(),
		validTo: text.nullable(),
		projectedDepletion: text.nullable()
	}),
	z.object({
		state: z.enum(['none', 'no_billing_access', 'not_configured', 'unavailable'])
	})
]);

const usage = z.discriminatedUnion('state', [
	z.object({
		state: z.literal('ok'),
		currency: text.nullable(),
		from: text.nullable(),
		through: text.nullable(),
		totalCents: cents,
		services: z.array(z.object({ name: text, cents }))
	}),
	z.object({ state: z.enum(['not_configured', 'unavailable']) })
]);

const rate = z.number().nullable();

const headroom = z.discriminatedUnion('state', [
	z.object({
		state: z.literal('ok'),
		kvNamespaces: count,
		kvLimit: count,
		buckets: count,
		scripts: count.nullable(),
		databases: count.nullable(),
		rate: z.object({
			remaining: rate,
			quota: rate,
			resetSeconds: rate,
			windowSeconds: rate
		})
	}),
	z.object({ state: z.enum(['not_configured', 'unavailable']) })
]);

const work = z.object({
	running: count,
	failedLastDay: count,
	recentFailures: z.array(
		z.object({
			id: text,
			type: text,
			siteId: text.nullable(),
			reason: text.nullable(),
			at: z.number()
		})
	),
	sites: z.record(text, count)
});

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.capacity.read',
		rateClass: 'read',
		tags: ['admin'],
		summary: 'Read the platform capacity',
		description:
			'Cloudflare credit balance, billable usage by service, account headroom, and the work in flight. The Cloudflare reads are cached for 60 seconds. Needs the admin role and a Cloudflare Access login.',
		response: z.object({
			generatedAt: z.number(),
			credits,
			usage,
			headroom,
			work
		})
	},
	(): Promise<CapacityView> => readCapacity()
);

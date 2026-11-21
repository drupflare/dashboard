import { hostname, siteKind } from '@contracts/sites';
import { z } from 'zod';

export const siteCreateBodySchema = z.strictObject({
	kind: siteKind,
	name: z.string().min(1).max(63),
	hostnameLabel: z.string().min(1).max(63).optional(),
	templateEntryId: z.string().min(1).max(40).optional(),
	bundleId: z.string().min(1).max(64).optional(),
	plane: z.enum(['managed', 'self-managed']).optional(),
	connectionId: z.string().min(1).max(64).optional(),
	customHost: z
		.strictObject({ hostname: hostname, zoneId: z.string().regex(/^[0-9a-f]{32}$/) })
		.optional()
});

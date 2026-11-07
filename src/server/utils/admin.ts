import { z } from 'zod';

export const adminPageQuery = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(25),
	before: z.coerce.number().int().positive().optional()
});

export const adminPageOf = <T extends z.ZodType>(item: T) =>
	z.object({ items: z.array(item), nextBefore: z.number().nullable() });

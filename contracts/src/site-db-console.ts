import { z } from 'zod';
import { siteId } from './common';

export const SITE_DB_CONSOLE_VERSION = { major: 1, minor: 0 } as const;
export const SITE_DB_CONSOLE_CONTRACT = 'site-db-console';

export const MAX_ROWS = 1000;

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

// the worker runs the statement on a read-only connection; the schema only bounds sizes
export const consoleRequestSchema = z.object({
	v: z.literal(SITE_DB_CONSOLE_VERSION.major),
	siteId,
	sql: z.string().min(1).max(10_000),
	params: z.array(cell).max(100),
	limit: z.int().positive().max(MAX_ROWS),
	timeoutMs: z.int().positive().max(30_000)
});

export const consoleResponseSchema = z.object({
	columns: z.array(z.string()),
	rows: z.array(z.array(cell)).max(MAX_ROWS),
	truncated: z.boolean(),
	elapsedMs: z.number().nonnegative()
});

export const consoleRefusalSchema = z.object({
	code: z.enum(['not_read_only', 'timeout', 'too_large', 'unavailable']),
	message: z.string()
});

export type ConsoleRequest = z.infer<typeof consoleRequestSchema>;
export type ConsoleResponse = z.infer<typeof consoleResponseSchema>;

export const schemas = {
	consoleRequest: consoleRequestSchema,
	consoleResponse: consoleResponseSchema,
	consoleRefusal: consoleRefusalSchema
};

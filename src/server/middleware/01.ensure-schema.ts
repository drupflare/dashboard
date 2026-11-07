import { defineEventHandler } from 'h3';
import { ensureSchema, requireSchema } from '../db/schema-gate';

export default defineEventHandler(async (event) => {
	if (import.meta.prerender) return;
	const startedAt = Date.now();
	await requireSchema(ensureSchema, event.context.cloudflare.env);
	const ms = Date.now() - startedAt;
	if (ms >= 25) console.info('schema.gate', JSON.stringify({ ms }));
});

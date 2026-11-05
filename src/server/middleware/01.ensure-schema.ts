import { defineEventHandler } from 'h3';
import { ensureSchema, requireSchema } from '../db/schema-gate';

export default defineEventHandler(async (event) => {
	if (import.meta.prerender) return;
	await requireSchema(ensureSchema, event.context.cloudflare.env);
});

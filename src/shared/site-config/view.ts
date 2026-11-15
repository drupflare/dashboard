import { z } from 'zod';
import { CONFIG_GROUPS } from '../permissions';

export const CONFIG_GROUP_LABELS: Record<(typeof CONFIG_GROUPS)[number], string> = {
	runtime: 'Runtime',
	content: 'Content',
	security: 'Security',
	integrations: 'Integrations',
	appearance: 'Appearance',
	access: 'Access'
};

export const settingsFieldSchema = z.object({
	key: z.string(),
	label: z.string(),
	description: z.string().nullable(),
	group: z.enum(CONFIG_GROUPS),
	widget: z.string(),
	bounds: z
		.object({
			min: z.number().optional(),
			max: z.number().optional(),
			unit: z.string().optional()
		})
		.nullable(),
	schema: z.record(z.string(), z.unknown()),
	value: z.unknown(),
	provenance: z.enum(['default', 'var', 'kv', 'override']).nullable(),
	danger: z.boolean(),
	editable: z.boolean(),
	readOnlyReason: z.string().nullable()
});

export const settingsGroupSchema = z.object({
	id: z.enum(CONFIG_GROUPS),
	label: z.string(),
	fields: z.array(settingsFieldSchema)
});

export const settingsViewSchema = z.object({
	state: z.enum(['ready', 'fallback', 'empty']),
	source: z.enum(['live', 'stored', 'registry']).nullable(),
	stale: z.boolean(),
	observedAt: z.string().nullable(),
	reason: z.string().nullable(),
	// sent back with a write, so a change made elsewhere since this read is noticed
	etag: z.string().nullable(),
	groups: z.array(settingsGroupSchema),
	redirects: z.array(z.object({ from: z.string(), to: z.string() }))
});

export type SettingsField = z.infer<typeof settingsFieldSchema>;
export type SettingsGroup = z.infer<typeof settingsGroupSchema>;
export type SettingsView = z.infer<typeof settingsViewSchema>;

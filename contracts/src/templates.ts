import { z } from 'zod';

export const TEMPLATES_VERSION = { major: 1, minor: 0 } as const;
export const TEMPLATES_CONTRACT = 'templates';
export const TEMPLATE_MANIFEST_FILE = 'drupflare.template.json';

export const BINDING_TYPES = ['d1', 'kv', 'r2', 'durable_object', 'queue', 'ai'] as const;

export const templateBindingSchema = z.object({
	type: z.enum(BINDING_TYPES),
	name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)
});

export const templateManifestSchema = z.object({
	v: z.literal(TEMPLATES_VERSION.major),
	slug: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/),
	name: z.string().min(1).max(100),
	version: z.string().min(1).max(64),
	description: z.string().max(500),
	build: z.object({
		command: z.string().min(1).nullable(),
		output: z.string().min(1)
	}),
	entry: z.string().min(1),
	compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	compatibilityFlags: z.array(z.string()),
	bindings: z.array(templateBindingSchema),
	secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)),
	discovery: z.boolean()
});

export type TemplateManifest = z.infer<typeof templateManifestSchema>;

export const schemas = { templateManifest: templateManifestSchema };

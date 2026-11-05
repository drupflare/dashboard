import { z } from 'zod';
import { siteKind } from './sites';

export const DISCOVERY_VERSION = { major: 1, minor: 0 } as const;
export const DISCOVERY_CONTRACT = 'discovery';
export const DISCOVERY_PATH = '/.well-known/drupflare';

export const SETTING_PERMISSIONS = [
	'runtime',
	'content',
	'security',
	'integrations',
	'appearance',
	'access'
] as const;
export const KNOWN_WIDGETS = [
	'color',
	'permission-matrix',
	'rate-limit',
	'lever-slider',
	'secret',
	'json'
] as const;
export const PROVENANCES = ['default', 'var', 'kv', 'override'] as const;
export const WRITE_LAYERS = ['var', 'kv', 'override'] as const;
export const ROUTE_CLASSES = ['safe', 'rebuild', 'stateful'] as const;
export const ROUTE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export const ROUTE_AUTHS = [
	'owner-token',
	'management-key',
	'assertion',
	'session',
	'none'
] as const;
export const CAPABILITY_STATES = ['enabled', 'disabled', 'unavailable', 'degraded'] as const;

export const settingPermission = z.enum(SETTING_PERMISSIONS);

// a widget the dashboard does not know renders as a json editor, so the field stays a free string
export const xUiSchema = z.object({
	group: z.string().min(1),
	permission: settingPermission,
	widget: z.string().min(1).optional(),
	planGate: z.string().min(1).optional(),
	danger: z.boolean().optional(),
	docLink: z.url().optional()
});

export const capabilitySchema = z.object({
	id: z.string().min(1),
	state: z.enum(CAPABILITY_STATES),
	reason: z.string().nullable()
});

export const settingsSchema = z.object({
	schema: z.record(z.string(), z.unknown()),
	values: z.record(z.string(), z.unknown()),
	provenance: z.record(z.string(), z.enum(PROVENANCES)),
	writable: z.record(z.string(), z.enum(WRITE_LAYERS)),
	etag: z.string().min(1)
});

export const routeSchema = z.object({
	id: z.string().min(1),
	method: z.enum(ROUTE_METHODS),
	path: z.string().startsWith('/'),
	class: z.enum(ROUTE_CLASSES),
	auth: z.enum(ROUTE_AUTHS)
});

export const redirectSchema = z.object({
	from: z.string().startsWith('/'),
	to: z.string().startsWith('/')
});

export const discoveryDocumentSchema = z.object({
	v: z.literal(DISCOVERY_VERSION.major),
	kind: siteKind,
	version: z.string().min(1),
	releaseId: z.string().min(1),
	schemaVersion: z.int().nonnegative(),
	capabilities: z.array(capabilitySchema),
	settings: settingsSchema,
	routes: z.array(routeSchema),
	redirects: z.array(redirectSchema),
	healthVocabulary: z.array(z.string().min(1)),
	limits: z.record(z.string(), z.number())
});

export type XUi = z.infer<typeof xUiSchema>;
export type DiscoveryDocument = z.infer<typeof discoveryDocumentSchema>;

export const schemas = {
	xUi: xUiSchema,
	capability: capabilitySchema,
	route: routeSchema,
	discoveryDocument: discoveryDocumentSchema
};

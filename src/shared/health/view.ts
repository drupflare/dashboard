import { z } from 'zod';
import { HEALTH_LEVELS } from './vocab';

export const HEALTH_STATUSES = [
	'healthy',
	'attention',
	'starting',
	'unreachable',
	'unreadable'
] as const;

export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const READINESS_VIEW_LEVELS = ['pending', 'live', 'verified', 'production-ready'] as const;

export const READINESS_TIERS = ['live', 'verified', 'production-ready'] as const;

export const READINESS_STATES = ['done', 'open', 'not-checked'] as const;

const levelSchema = z.enum(HEALTH_LEVELS);

type NodeFields = {
	id: string;
	source: 'reconcile' | 'supervisor' | 'repair';
	level: (typeof HEALTH_LEVELS)[number];
	state: string;
	title: string;
	detail: string;
	handle: string | null;
	history: { state: string; atMs: number }[];
	guidance: { text: string; diagnostics: { label: string; value: string }[] } | null;
};

// the tree has two levels: a chain and its steps or findings
export type HealthLeafView = NodeFields & { children: [] };

export type HealthNodeView = NodeFields & { children: HealthLeafView[] };

const nodeFields = {
	id: z.string(),
	source: z.enum(['reconcile', 'supervisor', 'repair']),
	level: levelSchema,
	state: z.string(),
	title: z.string(),
	detail: z.string(),
	handle: z.string().nullable(),
	history: z.array(z.strictObject({ state: z.string(), atMs: z.number() })),
	guidance: z
		.strictObject({
			text: z.string(),
			diagnostics: z.array(z.strictObject({ label: z.string(), value: z.string() }))
		})
		.nullable()
};

const leafSchema = z.strictObject({ ...nodeFields, children: z.tuple([]) });

export const healthNodeSchema = z.strictObject({
	...nodeFields,
	children: z.array(leafSchema)
});

export const readinessViewSchema = z.strictObject({
	level: z.enum(READINESS_VIEW_LEVELS),
	missing: z.array(z.string()),
	checks: z.array(
		z.strictObject({
			label: z.string(),
			tier: z.enum(READINESS_TIERS),
			state: z.enum(READINESS_STATES)
		})
	)
});

export type ReadinessView = z.infer<typeof readinessViewSchema>;

export const siteHealthSchema = z.strictObject({
	status: z.enum(HEALTH_STATUSES),
	level: levelSchema,
	reachable: z.boolean(),
	reason: z.string().nullable(),
	step: z.string().nullable(),
	nodes: z.array(healthNodeSchema),
	readiness: readinessViewSchema,
	observedAt: z.string()
});

export type SiteHealth = z.infer<typeof siteHealthSchema>;

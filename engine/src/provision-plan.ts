import { siteId } from '@contracts/common';
import type { SiteConfig } from '@contracts/sites';

export const RESOURCE_KINDS = ['kv', 'r2', 'd1'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export interface ResourceSpec {
	binding: string;
	kind: ResourceKind;
	suffix: string;
	configs: readonly SiteConfig[];
	optional: boolean;
}

const BOTH: readonly SiteConfig[] = ['managed', 'canonical'];

export const RESOURCE_SPECS: readonly ResourceSpec[] = [
	{ binding: 'CONFIG_KV', kind: 'kv', suffix: 'config', configs: BOTH, optional: false },
	{ binding: 'PAGE_KV', kind: 'kv', suffix: 'page', configs: BOTH, optional: false },
	{ binding: 'FILES', kind: 'r2', suffix: 'files', configs: ['managed'], optional: false },
	{
		binding: 'FILES_PRIVATE',
		kind: 'r2',
		suffix: 'files-private',
		configs: ['managed'],
		optional: false
	},
	{ binding: 'FLEET_DB', kind: 'd1', suffix: 'db', configs: BOTH, optional: true }
];

export function resourceSpecs(config: SiteConfig): ResourceSpec[] {
	return RESOURCE_SPECS.filter((spec) => spec.configs.includes(config));
}

export interface PlannedResource {
	kind: ResourceKind;
	binding: string;
	name: string;
}

export interface ResourcePlan {
	siteId: string;
	config: SiteConfig;
	create: PlannedResource[];
	rollback: PlannedResource[];
}

export interface PlanOptions {
	database?: boolean;
}

export class InvalidSiteIdError extends Error {
	readonly code = 'invalid_site_id';

	constructor(readonly value: string) {
		super(`${JSON.stringify(value)} is not a site id`);
		this.name = 'InvalidSiteIdError';
	}
}

// bucket names cannot hold an underscore, so the id loses its prefix and keeps its letters
export function resourceName(id: string, suffix: string): string {
	if (!siteId.safeParse(id).success) throw new InvalidSiteIdError(id);
	return `s-${id.slice('site_'.length)}-${suffix}`;
}

export function planResources(
	site: { id: string },
	config: SiteConfig,
	options: PlanOptions = {}
): ResourcePlan {
	const create = resourceSpecs(config)
		.filter((spec) => !spec.optional || (spec.kind === 'd1' && options.database === true))
		.map((spec) => ({
			kind: spec.kind,
			binding: spec.binding,
			name: resourceName(site.id, spec.suffix)
		}));
	return { siteId: site.id, config, create, rollback: [...create].reverse() };
}

// a retry skips what an earlier attempt already recorded
export function remainingResources(
	plan: ResourcePlan,
	recorded: readonly { binding: string }[]
): PlannedResource[] {
	const done = new Set(recorded.map((resource) => resource.binding));
	return plan.create.filter((resource) => !done.has(resource.binding));
}

export interface AccountLimits {
	kvNamespaces: number;
	requestsPerWindow: number;
	windowSeconds: number;
}

export interface AccountUsage {
	kvNamespaces: number | null;
}

export interface CallCount {
	creates: number;
	lookups: number;
	rollbackDeletes: number;
}

export function countCalls(plan: ResourcePlan): CallCount {
	return {
		creates: plan.create.length,
		lookups: new Set(plan.create.map((resource) => resource.kind)).size,
		rollbackDeletes: plan.rollback.length
	};
}

export class InvalidLimitsError extends Error {
	readonly code = 'invalid_limits';

	constructor(readonly field: string) {
		super(`${field} must be a positive number`);
		this.name = 'InvalidLimitsError';
	}
}

const number = (value: number) => value.toLocaleString('en-US');

export function dryRun(plan: ResourcePlan, limits: AccountLimits, usage: AccountUsage): string {
	for (const [field, value] of Object.entries(limits)) {
		if (!Number.isFinite(value) || value <= 0) throw new InvalidLimitsError(field);
	}
	const calls = countCalls(plan);
	const peak = calls.creates + calls.lookups + calls.rollbackDeletes;
	const lines = [
		`Dry run for ${plan.siteId} on the ${plan.config} config. Nothing is created.`,
		''
	];

	lines.push('Create, in order:');
	plan.create.forEach((resource, index) => {
		lines.push(`  ${index + 1}. ${resource.kind} ${resource.binding} ${resource.name}`);
	});
	lines.push('', 'Roll back, in this order if a step fails:');
	plan.rollback.forEach((resource, index) => {
		lines.push(`  ${index + 1}. delete ${resource.kind} ${resource.name}`);
	});

	lines.push(
		'',
		`API calls: ${calls.creates} to create, ${calls.lookups} to look up what exists on a retry, ` +
			`${calls.rollbackDeletes} to delete on rollback, ${peak} at most.`,
		'',
		'Account limits:'
	);

	const kvAdded = plan.create.filter((resource) => resource.kind === 'kv').length;
	if (usage.kvNamespaces === null) {
		lines.push(
			`  KV namespaces: ${kvAdded} added, in use unknown, limit ${number(limits.kvNamespaces)}.`
		);
	} else {
		const after = usage.kvNamespaces + kvAdded;
		const verdict =
			after > limits.kvNamespaces
				? `over the limit by ${number(after - limits.kvNamespaces)}`
				: 'within the limit';
		lines.push(
			`  KV namespaces: ${kvAdded} added to ${number(usage.kvNamespaces)}, ` +
				`${number(after)} of ${number(limits.kvNamespaces)}, ${verdict}.`
		);
	}
	const minutes = limits.windowSeconds / 60;
	const share = ((peak / limits.requestsPerWindow) * 100).toFixed(1);
	lines.push(
		`  Request rate: ${peak} of ${number(limits.requestsPerWindow)} requests per ` +
			`${number(minutes)} minutes, ${share}% of the window.`
	);
	return lines.join('\n');
}

import { siteId } from '@contracts/common';
import type { SiteConfig, SiteKind, SitePlane, SiteRing } from '@contracts/sites';
import type { Binding, Migration, UploadMetadata } from '@drupflare/workforce';
import { type ResourceKind, resourceSpecs } from './provision-plan';

export interface ModuleRule {
	type: 'CompiledWasm' | 'Data' | 'Text';
	globs: string[];
	fallthrough: boolean;
}

export interface DescriptorSite {
	id: string;
	orgId: string;
	kind: SiteKind;
	plane: SitePlane;
	ring: SiteRing;
	plan: string;
}

export interface SiteResourceRef {
	siteId: string;
	kind: ResourceKind;
	binding: string;
	providerId: string;
}

export interface RecipeBindings {
	durableObjects: { name: string; class_name: string }[];
	migrations: Migration[];
	crons: string[];
	sendEmail: string | null;
	versionMetadata: string | null;
}

export interface DescriptorInput {
	config: SiteConfig;
	site: DescriptorSite;
	resources: readonly SiteResourceRef[];
	secrets: Readonly<Record<string, string>>;
	release: { id: string; assetsToken?: string | null };
	recipe?: RecipeBindings;
}

export interface Descriptor {
	metadata: UploadMetadata;
	rules: ModuleRule[];
	crons: string[];
}

export const DESCRIPTOR_ERROR_CODES = [
	'invalid_site',
	'foreign_resource',
	'duplicate_resource',
	'unexpected_resource',
	'missing_resource',
	'invalid_secret_name',
	'secret_collision'
] as const;

export class DescriptorError extends Error {
	constructor(
		readonly code: (typeof DESCRIPTOR_ERROR_CODES)[number],
		message: string
	) {
		super(message);
		this.name = 'DescriptorError';
	}
}

const COMPATIBILITY_DATE = '2026-08-01';
const COMPATIBILITY_FLAGS = ['nodejs_compat'];

const VARS: Readonly<Record<string, string>> = {
	CMS: 'drupal',
	LAZY_MOUNT: '1',
	LAZY_FS_BUDGET_BYTES: '4194304',
	GEN_BUCKET_MS: '5000',
	ASSET_AGGREGATES: '1',
	SITE_ID_PORTS: 'strip'
};

const MANAGED_VARS: Readonly<Record<string, string>> = {
	CACHE_API: 'off',
	FILE_STORE: 'r2'
};

const DURABLE_OBJECTS = [
	{ name: 'SITE', class_name: 'SitePhpDurableObject' },
	{ name: 'RENDER_LANES', class_name: 'RenderLane' }
];

const MIGRATIONS: Migration[] = [
	{ tag: 'v1', new_sqlite_classes: ['SitePhpDurableObject'] },
	{ tag: 'v2', new_sqlite_classes: ['RenderLane'] }
];

const RULES: ModuleRule[] = [
	{ type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: true },
	{ type: 'Data', globs: ['**/*.zst', '**/*.br'], fallthrough: true },
	{ type: 'Text', globs: ['**/composer.lock'], fallthrough: true }
];

const CRONS = ['*/5 * * * *'];

// a site made before its script recorded a migration tag ran both Drupal migrations
export const UNTAGGED_MIGRATION_TAG = 'v2';

const tagValue = (tags: readonly string[], prefix: string) =>
	tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length) ?? null;

export const releaseOfTags = (tags: readonly string[]) => tagValue(tags, 'v:');

// the script's own tags are where its latest applied migration tag is kept
export const migrationTagOfTags = (tags: readonly string[]) => tagValue(tags, 'm:');

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

const REDACTED = '[redacted]';

function bindingsFor(input: DescriptorInput): RecipeBindings {
	return (
		input.recipe ?? {
			durableObjects: DURABLE_OBJECTS,
			migrations: MIGRATIONS,
			crons: CRONS,
			sendEmail: input.config === 'managed' ? 'SEND_EMAIL' : null,
			versionMetadata: 'CF_VERSION_METADATA'
		}
	);
}

function resourceBinding(ref: SiteResourceRef): Binding {
	if (ref.kind === 'kv')
		return { type: 'kv_namespace', name: ref.binding, namespace_id: ref.providerId };
	if (ref.kind === 'r2')
		return { type: 'r2_bucket', name: ref.binding, bucket_name: ref.providerId };
	return { type: 'd1', name: ref.binding, id: ref.providerId };
}

function checkResources(input: DescriptorInput): SiteResourceRef[] {
	const specs = resourceSpecs(input.config);
	const byBinding = new Map<string, SiteResourceRef>();
	for (const ref of input.resources) {
		if (ref.siteId !== input.site.id) {
			throw new DescriptorError(
				'foreign_resource',
				`${ref.binding} belongs to ${ref.siteId}, not ${input.site.id}`
			);
		}
		if (byBinding.has(ref.binding)) {
			throw new DescriptorError('duplicate_resource', `${ref.binding} is given twice`);
		}
		const spec = specs.find((item) => item.binding === ref.binding);
		if (spec === undefined || spec.kind !== ref.kind) {
			throw new DescriptorError(
				'unexpected_resource',
				`the ${input.config} config has no ${ref.kind} binding named ${ref.binding}`
			);
		}
		byBinding.set(ref.binding, ref);
	}
	for (const spec of specs) {
		if (!spec.optional && !byBinding.has(spec.binding)) {
			throw new DescriptorError('missing_resource', `${spec.binding} has no resource`);
		}
	}
	return specs.flatMap((spec) => byBinding.get(spec.binding) ?? []);
}

function checkSecrets(secrets: Readonly<Record<string, string>>, taken: Set<string>): Binding[] {
	const out: Binding[] = [];
	for (const name of Object.keys(secrets).sort()) {
		if (!SECRET_NAME.test(name)) {
			throw new DescriptorError(
				'invalid_secret_name',
				`${JSON.stringify(name)} is not a binding name`
			);
		}
		if (taken.has(name)) {
			throw new DescriptorError(
				'secret_collision',
				`${name} is already a binding of the config`
			);
		}
		out.push({ type: 'secret_text', name, text: secrets[name]! });
	}
	return out;
}

export function buildDescriptor(input: DescriptorInput): Descriptor {
	const { site, release } = input;
	if (!siteId.safeParse(site.id).success) {
		throw new DescriptorError('invalid_site', `${JSON.stringify(site.id)} is not a site id`);
	}
	const refs = checkResources(input);
	const recipe = bindingsFor(input);

	const vars: Record<string, string> = {
		...VARS,
		...(input.config === 'managed' ? MANAGED_VARS : {}),
		PLAN: site.plan,
		SITE_ID: site.id
	};
	const bindings: Binding[] = [
		...Object.entries(vars).map(([name, text]) => ({
			type: 'plain_text' as const,
			name,
			text
		})),
		...recipe.durableObjects.map((object) => ({
			type: 'durable_object_namespace' as const,
			...object
		})),
		...refs.map(resourceBinding)
	];
	if (recipe.sendEmail !== null) bindings.push({ type: 'send_email', name: recipe.sendEmail });
	if (recipe.versionMetadata !== null)
		bindings.push({ type: 'version_metadata', name: recipe.versionMetadata });
	bindings.push({ type: 'assets', name: 'ASSETS' });
	bindings.push(...checkSecrets(input.secrets, new Set(bindings.map((binding) => binding.name))));

	const lastTag = recipe.migrations[recipe.migrations.length - 1]?.tag;
	const metadata: UploadMetadata = {
		bindings,
		compatibility_date: COMPATIBILITY_DATE,
		compatibility_flags: [...COMPATIBILITY_FLAGS],
		migrations: structuredClone(recipe.migrations),
		observability: { enabled: true },
		tags: [
			`o:${site.orgId}`,
			`s:${site.id}`,
			`k:${site.kind}`,
			`p:${site.plane}`,
			`r:${site.ring}`,
			`v:${release.id}`,
			...(lastTag === undefined ? [] : [`m:${lastTag}`])
		]
	};
	if (release.assetsToken) metadata.assets = { jwt: release.assetsToken };

	return { metadata, rules: structuredClone(RULES), crons: [...recipe.crons] };
}

export function redact(descriptor: Descriptor): Descriptor {
	const { metadata } = descriptor;
	const redacted: UploadMetadata = {
		...metadata,
		bindings: metadata.bindings?.map((binding) =>
			binding.type === 'secret_text' ? { ...binding, text: REDACTED } : binding
		)
	};
	if (metadata.assets) redacted.assets = { ...metadata.assets, jwt: REDACTED };
	return { ...descriptor, metadata: redacted };
}

import { z } from 'zod';
import { digestSchema, isoTimestamp } from './common';

export const RELEASES_VERSION = { major: 1, minor: 0 } as const;
export const RELEASES_CONTRACT = 'releases';

export const RELEASE_KINDS = ['worker', 'php', 'drupal-pack'] as const;
export const RELEASE_EVENT_TYPES = ['release.published', 'interpreter.published'] as const;

export const releaseKind = z.enum(RELEASE_KINDS);

export const releaseAssetSchema = z.object({
	name: z.string().min(1).max(200),
	url: z.url(),
	digest: digestSchema
});

// schemaVersion is the data schema a release leaves a site at, which a rollback target must accept
export const releaseManifestSchema = z.object({
	kind: releaseKind,
	version: z.string().min(1).max(64),
	schemaVersion: z.int().nonnegative(),
	acceptsSchema: z.int().nonnegative(),
	assets: z.array(releaseAssetSchema)
});

export const releaseEventSchema = z.object({
	v: z.literal(RELEASES_VERSION.major),
	id: z.string().min(8).max(64),
	type: z.enum(RELEASE_EVENT_TYPES),
	kind: releaseKind,
	version: z.string().min(1).max(64),
	manifestDigest: digestSchema,
	manifestUrl: z.url(),
	schemaVersion: z.int().nonnegative(),
	acceptsSchema: z.int().nonnegative(),
	publishedAt: isoTimestamp,
	advisoryAt: isoTimestamp.nullable()
});

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
export type ReleaseEvent = z.infer<typeof releaseEventSchema>;

export const schemas = {
	releaseManifest: releaseManifestSchema,
	releaseEvent: releaseEventSchema
};

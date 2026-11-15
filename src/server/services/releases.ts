import { sha256Digest } from '@contracts/common';
import {
	releaseEventSchema,
	releaseManifestSchema,
	type ReleaseEvent,
	type ReleaseManifest
} from '@contracts/releases';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { ApiError } from '../../shared/errors';
import {
	getRelease,
	listReleases,
	registerRelease,
	type ReleaseKind,
	type ReleaseRecord
} from '../db/repos/releases';
import {
	guardedFetch,
	UrlGuardError,
	type FetchLike,
	type Resolver
} from '../integrations/url-guard';
import { hmacSha256Hex, timingSafeEqual } from './crypto';
import type { OnceStore } from './single-use';

export interface ReleaseServices {
	getDb: () => Promise<CollegeDBClient>;
	once: OnceStore;
	fetch: FetchLike;
	resolve: Resolver;
	now: () => number;
	// empty turns the signed hook off
	hookSecret: string;
}

let installed: ReleaseServices | null = null;

export function setReleaseServices(services: ReleaseServices | null): void {
	installed = services;
}

export function releaseServices(): ReleaseServices {
	if (installed === null) throw new ApiError('not_built', 'Release intake is not available yet');
	return installed;
}

const MAX_MANIFEST_BYTES = 512 * 1024;
const EVENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const refuse = (message: string, reason: string, extra: Record<string, unknown> = {}) =>
	new ApiError('unprocessable', message, { reason, ...extra });

export interface Registration {
	kind: ReleaseKind;
	version: string;
	manifestUrl: string;
	manifestDigest: string;
	publishedAt: number;
	advisoryAt: number | null;
	// fields the sender states; they must match the manifest
	schemaVersion?: number;
	acceptsSchema?: number;
	// the id a site's release_id holds, when it differs from the version
	releaseId?: string;
}

async function fetchManifest(
	services: ReleaseServices,
	input: Registration
): Promise<ReleaseManifest> {
	let body: Uint8Array;
	try {
		const response = await guardedFetch(
			input.manifestUrl,
			{ fetch: services.fetch, resolve: services.resolve },
			{ maxRedirects: 2, maxBytes: MAX_MANIFEST_BYTES, timeoutMs: 10_000 }
		);
		if (response.status !== 200) {
			throw refuse('The manifest could not be fetched', 'manifest_unreachable', {
				status: response.status
			});
		}
		body = response.body;
	} catch (error) {
		if (error instanceof UrlGuardError) {
			throw refuse('The manifest address was refused', 'manifest_url_refused', {
				code: error.code
			});
		}
		throw error;
	}
	if ((await sha256Digest(body)) !== input.manifestDigest) {
		throw refuse('The manifest does not match its digest', 'digest_mismatch');
	}
	let json: unknown;
	try {
		json = JSON.parse(new TextDecoder().decode(body));
	} catch {
		throw refuse('The manifest is not valid JSON', 'manifest_invalid');
	}
	const parsed = releaseManifestSchema.safeParse(json);
	if (!parsed.success) throw refuse('The manifest is not valid', 'manifest_invalid');
	return parsed.data;
}

// the hook and the admin form both end here
export async function registerFromManifest(
	services: ReleaseServices,
	input: Registration
): Promise<{ release: ReleaseRecord; created: boolean }> {
	const manifest = await fetchManifest(services, input);
	const same =
		manifest.kind === input.kind &&
		manifest.version === input.version &&
		(input.schemaVersion === undefined || manifest.schemaVersion === input.schemaVersion) &&
		(input.acceptsSchema === undefined || manifest.acceptsSchema === input.acceptsSchema);
	if (!same) {
		throw refuse('The event and the manifest disagree', 'event_manifest_mismatch');
	}
	const db = await services.getDb();
	const id = input.releaseId ?? manifest.version;
	const existing = await getRelease(db, id);
	if (
		existing !== null &&
		(existing.kind !== manifest.kind ||
			existing.version !== manifest.version ||
			existing.manifestDigest !== input.manifestDigest)
	) {
		throw new ApiError('conflict', 'A different release is registered under that id', {
			reason: 'release_changed'
		});
	}
	const stored = await registerRelease(db, {
		id,
		kind: manifest.kind,
		version: manifest.version,
		manifestDigest: input.manifestDigest,
		schemaVersion: manifest.schemaVersion,
		acceptsSchema: manifest.acceptsSchema,
		publishedAt: input.publishedAt,
		advisoryAt: input.advisoryAt,
		now: services.now()
	});
	if (stored.release.manifestDigest !== input.manifestDigest) {
		throw new ApiError('conflict', 'That version is registered with a different manifest', {
			reason: 'release_changed'
		});
	}
	return stored;
}

export async function listRegistered(
	services: ReleaseServices,
	kind: ReleaseKind,
	count = 50
): Promise<ReleaseRecord[]> {
	return listReleases(await services.getDb(), kind, count);
}

// #region signed event

export interface EventResult {
	duplicate: boolean;
	releaseId: string | null;
}

export async function acceptReleaseEvent(
	services: ReleaseServices,
	input: { rawBody: string; signature: string | null }
): Promise<EventResult> {
	const { hookSecret } = services;
	if (hookSecret === '') throw new ApiError('not_built', 'Release events are not turned on');
	const expected = `sha256=${await hmacSha256Hex(hookSecret, input.rawBody)}`;
	if (input.signature === null || !timingSafeEqual(input.signature, expected)) {
		throw new ApiError('unauthenticated', 'The signature is not valid');
	}
	let json: unknown;
	try {
		json = JSON.parse(input.rawBody);
	} catch {
		throw new ApiError('validation', 'The body is not valid JSON');
	}
	const parsed = releaseEventSchema.safeParse(json);
	if (!parsed.success) throw new ApiError('validation', 'The event is not valid');
	const event: ReleaseEvent = parsed.data;
	const key = `release-event:${event.id}`;
	const now = services.now();
	if ((await services.once.get(key, now)) !== null) {
		return { duplicate: true, releaseId: null };
	}
	const { release } = await registerFromManifest(services, {
		kind: event.kind,
		version: event.version,
		manifestUrl: event.manifestUrl,
		manifestDigest: event.manifestDigest,
		publishedAt: Date.parse(event.publishedAt),
		advisoryAt: event.advisoryAt === null ? null : Date.parse(event.advisoryAt),
		schemaVersion: event.schemaVersion,
		acceptsSchema: event.acceptsSchema
	});
	await services.once.put(key, release.id, now + EVENT_TTL_MS);
	return { duplicate: false, releaseId: release.id };
}

// #endregion

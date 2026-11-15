import { sha256Hex } from '@contracts/common';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { z } from 'zod';
import {
	buildCustomBundle,
	CUSTOM_ARCHIVE_MAX_BYTES,
	CustomBundleError,
	customKeys,
	customMigrationRefusal,
	customReleaseId,
	guardShapeOf,
	putCustomBundle,
	readStreamCapped,
	unpackArchive
} from '../../../engine/src/custom-bundle';
import { ApiError } from '../../shared/errors';
import { PLANS } from '../../shared/plans';
import { findingSchema, recipeSchema } from '../../shared/recipes';
import {
	getCustomRelease,
	registerCustomRelease,
	type CustomRelease
} from '../db/repos/custom-releases';
import type { Entitlement } from '../domain/entitlements';

export interface CustomBundleServices {
	getDb: () => Promise<CollegeDBClient>;
	planOf: (orgId: string) => Promise<Entitlement>;
	// the engine reads the parts from here, so a bundle never rides in an operation or a start
	blobs: { put(key: string, bytes: Uint8Array): Promise<void> };
	now: () => number;
}

const notBuilt = (what: string) => async (): Promise<never> => {
	throw new ApiError('not_built', `${what} is not available yet`);
};

function productionServices(): CustomBundleServices {
	return {
		getDb: notBuilt('The site store'),
		planOf: notBuilt('The plan lookup'),
		blobs: { put: notBuilt('The file store') },
		now: Date.now
	};
}

let installed = productionServices();

export function setCustomBundleServices(over: Partial<CustomBundleServices>): void {
	installed = { ...installed, ...over };
}

export function resetCustomBundleServices(): void {
	installed = productionServices();
}

export function customBundleServices(): CustomBundleServices {
	return installed;
}

export const bundleIntakeSchema = z.strictObject({
	// null when a finding blocks the bundle: nothing is stored for it
	bundleId: z.string().nullable(),
	sha256: z.string(),
	fileName: z.string(),
	deployable: z.boolean(),
	findings: z.array(findingSchema),
	recipe: recipeSchema
});
export type BundleIntake = z.infer<typeof bundleIntakeSchema>;

// the first plan that includes custom code, so a refusal can name what unlocks it
export function planUnlockingCustomCode(): { id: string; name: string } | null {
	const plan = PLANS.find(
		(candidate) =>
			candidate.customCode === true && candidate.kind === 'managed' && !candidate.disabled
	);
	return plan === undefined ? null : { id: plan.id, name: plan.name };
}

export function customCodeRefusal(): ApiError {
	return new ApiError('forbidden', 'Your plan does not include your own code', {
		requires: 'entitlement',
		feature: 'customCode',
		unlockedBy: planUnlockingCustomCode()
	});
}

async function requireCustomCode(
	services: Pick<CustomBundleServices, 'planOf'>,
	orgId: string
): Promise<void> {
	if (!(await services.planOf(orgId)).features.customCode) throw customCodeRefusal();
}

// what the archive was called, kept for the history: the last path part, printable, short
export function bundleFileName(value: string | undefined): string {
	const last = (value ?? '').split(/[\\/]/).pop() ?? '';
	const printable = last
		.replace(/\p{Cc}/gu, '')
		.trim()
		.slice(0, 100);
	return printable === '' ? 'bundle.tar.gz' : printable;
}

const archiveRefusal = (error: CustomBundleError) =>
	new ApiError(
		error.code === 'archive_too_large' ? 'validation' : 'unprocessable',
		error.message,
		{
			reason: error.code
		}
	);

export async function intakeCustomBundle(
	services: CustomBundleServices,
	input: { orgId: string; body: ReadableStream<Uint8Array> | null; fileName?: string }
): Promise<BundleIntake> {
	await requireCustomCode(services, input.orgId);
	if (input.body === null) throw new ApiError('validation', 'The request has no archive');
	const fileName = bundleFileName(input.fileName);
	let build;
	let sha256;
	let releaseId;
	let archive: Uint8Array;
	try {
		archive = await readStreamCapped(input.body, CUSTOM_ARCHIVE_MAX_BYTES);
		sha256 = await sha256Hex(archive);
		releaseId = await customReleaseId(input.orgId, sha256);
		build = await buildCustomBundle({
			files: await unpackArchive(archive),
			archiveSha256: sha256,
			releaseId,
			today: new Date(services.now()).toISOString().slice(0, 10)
		});
	} catch (error) {
		if (error instanceof CustomBundleError) throw archiveRefusal(error);
		throw error;
	}
	if (!build.deployable || build.bundle === null) {
		return {
			bundleId: null,
			sha256,
			fileName,
			deployable: false,
			findings: build.findings,
			recipe: build.recipe
		};
	}
	const bundleKey = customKeys.archive(input.orgId, sha256);
	await services.blobs.put(bundleKey, archive);
	await putCustomBundle(services.blobs, releaseId, build.bundle);
	const stored = await registerCustomRelease(await services.getDb(), {
		id: releaseId,
		organizationId: input.orgId,
		sha256,
		fileName,
		bundleKey,
		recipe: build.recipe,
		now: services.now()
	});
	return {
		bundleId: stored.id,
		sha256,
		fileName: stored.fileName,
		deployable: true,
		findings: build.findings,
		recipe: build.recipe
	};
}

// the release a request names, checked against the caller's organisation and plan: another
// organisation's id answers as unknown
export async function bundleForRequest(
	services: Pick<CustomBundleServices, 'getDb' | 'planOf'>,
	input: { orgId: string; bundleId: string }
): Promise<CustomRelease> {
	await requireCustomCode(services, input.orgId);
	const release = await getCustomRelease(await services.getDb(), input.orgId, input.bundleId);
	if (release === null) {
		throw new ApiError(
			'unprocessable',
			"That bundle is not one of this organisation's uploads",
			{
				reason: 'bundle_unknown'
			}
		);
	}
	return release;
}

const storeKey = (recipe: CustomRelease['recipe']) =>
	recipe.resources
		.filter((resource) => resource.kind !== 'send_email')
		.map((resource) => `${resource.kind}:${resource.binding}`)
		.sort()
		.join(',');

// an update keeps the stores the site already holds and only adds migration steps
export function updateRefusal(current: CustomRelease, target: CustomRelease): ApiError | null {
	if (storeKey(current.recipe) !== storeKey(target.recipe)) {
		return new ApiError(
			'unprocessable',
			'The new bundle uses different stores than the running site. Keep the same key-value, bucket and database bindings, or create a new site.',
			{ reason: 'resources_changed' }
		);
	}
	const reason = customMigrationRefusal(
		guardShapeOf(current.recipe),
		guardShapeOf(target.recipe)
	);
	return reason === null
		? null
		: new ApiError('unprocessable', `The update was refused: ${reason}.`, {
				reason: 'migration_refused'
			});
}

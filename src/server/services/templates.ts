import { newId } from '@contracts/common';
import {
	templateManifestSchema,
	type TemplateBundleManifest
} from '../../../engine/src/template-bundle';
import type { TemplateCreate } from '../../../engine/src/workflows/template-restore';
import { ApiError } from '../../shared/errors';
import { SINGLE_RESTORE_BYTES } from '../../shared/restore-limits';
import {
	FREE_DAILY_ROWS,
	isTemplateEntryId,
	TEMPLATE_CODE_DELIVERY,
	TEMPLATE_ENTRIES,
	TEMPLATE_ENTRY_IDS,
	TEMPLATE_HELD_REASON,
	templateCommit,
	templateFit,
	templateSpec,
	type TemplateEntryId,
	type TemplateFit,
	type TemplateState
} from '../../shared/template-entries';
import { nowUtc } from '../../shared/utils/time';
import {
	beginTemplateBuild,
	failTemplateBuild,
	getReadyTemplateBundle,
	hasOpenTemplateBuild,
	latestTemplateBundles,
	type TemplateBundleRecord
} from '../db/repos/template-bundles';
import { FREE_PLAN_ID } from '../domain/entitlements';
import { EngineStartError } from '../integrations/engine';
import type { SiteServices } from './sites';

// a build that has run longer than this is treated as dead, so its row stops blocking a new one
export const BUILD_STALE_MS = 45 * 60_000;

export interface TemplateView {
	id: TemplateEntryId;
	name: string;
	summary: string;
	state: TemplateState;
	commit: string;
	advisories: { id: string; package: string }[];
	patchNotes: { package: string; patch: string }[];
	fit: TemplateFit | null;
	usable: boolean;
	reason: string | null;
	builtAt: number | null;
}

const REASONS = {
	not_built: 'This template has not been built yet.',
	building: 'This template is being built.',
	failed: 'The last build of this template failed.',
	changed: 'This template changed and is being rebuilt.',
	too_large:
		'This template is larger than a new site can restore. A larger restore path is not available yet.'
} as const;

const freeRefusal = (fit: TemplateFit) =>
	`This template writes about ${fit.rows.toLocaleString('en-US')} rows on its first load, and the Free plan allows ${fit.limit.toLocaleString('en-US')} a day. Choose a paid plan to use it.`;

function manifestOf(row: TemplateBundleRecord): TemplateBundleManifest | null {
	if (row.manifest === null) return null;
	const parsed = templateManifestSchema.safeParse(JSON.parse(row.manifest));
	return parsed.success ? parsed.data : null;
}

export function databaseBytes(manifest: TemplateBundleManifest): number {
	return manifest.sections.find((section) => section.name === 'database.sql')?.bytes ?? 0;
}

// why a ready build still cannot be used, or null when it can
function refusalOf(manifest: TemplateBundleManifest, planId: string | null): string | null {
	if (databaseBytes(manifest) > SINGLE_RESTORE_BYTES) return REASONS.too_large;
	if (planId === FREE_PLAN_ID) {
		const fit = templateFit(manifest.rows, FREE_DAILY_ROWS);
		if (!fit.fits) return freeRefusal(fit);
	}
	return null;
}

export function viewOf(id: TemplateEntryId, row: TemplateBundleRecord | undefined): TemplateView {
	const entry = TEMPLATE_ENTRIES[id];
	const commit = templateCommit(id);
	const base = { id, name: entry.name, summary: entry.summary, commit };
	if (row === undefined) {
		return {
			...base,
			state: 'not_built',
			advisories: [],
			patchNotes: [],
			fit: null,
			usable: false,
			reason: REASONS.not_built,
			builtAt: null
		};
	}
	if (row.status !== 'ready') {
		return {
			...base,
			state: row.status,
			advisories: [],
			patchNotes: [],
			fit: null,
			usable: false,
			reason: REASONS[row.status],
			builtAt: null
		};
	}
	const manifest = manifestOf(row);
	if (manifest === null) {
		return {
			...base,
			state: 'failed',
			advisories: [],
			patchNotes: [],
			fit: null,
			usable: false,
			reason: REASONS.failed,
			builtAt: null
		};
	}
	const advisories = manifest.advisories ?? [];
	const fit = templateFit(manifest.rows, FREE_DAILY_ROWS);
	// a build of an older pin is not offered: the corpus pin moved since
	if (row.commit !== commit) {
		return {
			...base,
			state: 'not_built',
			advisories,
			patchNotes: manifest.patchesFailed,
			fit,
			usable: false,
			reason: REASONS.changed,
			builtAt: row.createdAt
		};
	}
	const reason = databaseBytes(manifest) > SINGLE_RESTORE_BYTES ? REASONS.too_large : null;
	return {
		...base,
		state: 'ready',
		advisories,
		patchNotes: manifest.patchesFailed,
		fit,
		// the free plan's gate is shown on the card; the create checks the real plan
		usable: reason === null,
		reason: reason ?? (fit.fits ? null : freeRefusal(fit)),
		builtAt: row.createdAt
	};
}

// the dependency wins when set; the shared constant is the default
export function templateCodeDeliveryOf(services: { templateCodeDelivery?: boolean }): boolean {
	return services.templateCodeDelivery ?? TEMPLATE_CODE_DELIVERY;
}

export async function listTemplates(
	services: Pick<SiteServices, 'getDb' | 'templateCodeDelivery'>
): Promise<TemplateView[]> {
	let latest = new Map<string, TemplateBundleRecord>();
	try {
		latest = await latestTemplateBundles(await services.getDb());
	} catch (error) {
		// without a store no template can have been built, so each reads as not built
		if (!(error instanceof ApiError) || error.code !== 'not_built') throw error;
	}
	const held = !templateCodeDeliveryOf(services);
	return TEMPLATE_ENTRY_IDS.map((id) => {
		const view = viewOf(id, latest.get(id));
		return held ? { ...view, usable: false, reason: TEMPLATE_HELD_REASON } : view;
	});
}

// the engine checks the same facts again before it restores anything
export async function templateForCreate(
	services: Pick<SiteServices, 'getDb'>,
	entryId: string,
	planId: string | null
): Promise<TemplateCreate> {
	if (!isTemplateEntryId(entryId)) {
		throw new ApiError('validation', 'This template does not exist', {
			field: 'templateEntryId'
		});
	}
	const commit = templateCommit(entryId);
	const row = await getReadyTemplateBundle(await services.getDb(), entryId, commit);
	const manifest = row === null ? null : manifestOf(row);
	if (row === null || manifest === null || row.bundleKey === null) {
		throw new ApiError('unprocessable', REASONS.not_built, { reason: 'template_not_ready' });
	}
	const refusal = refusalOf(manifest, planId);
	if (refusal !== null) {
		throw new ApiError('unprocessable', refusal, {
			reason:
				databaseBytes(manifest) > SINGLE_RESTORE_BYTES
					? 'template_too_large'
					: 'template_plan'
		});
	}
	return { entryId, commit, bundleKey: row.bundleKey };
}

export async function startTemplateBuild(
	services: Pick<SiteServices, 'getDb' | 'startOperation'>,
	entryId: string
): Promise<{ buildId: string }> {
	if (!isTemplateEntryId(entryId)) throw new ApiError('not_found', 'Not found');
	const db = await services.getDb();
	const now = nowUtc().toMillis();
	if (await hasOpenTemplateBuild(db, entryId, now - BUILD_STALE_MS)) {
		throw new ApiError('conflict', 'A build of this template is already running', {
			reason: 'build_running'
		});
	}
	const buildId = newId('tpl');
	const commit = templateCommit(entryId);
	await beginTemplateBuild(db, { id: buildId, entryId, commit, now });
	try {
		await services.startOperation({
			workflow: 'template-build',
			id: buildId,
			params: { buildId, entryId, commit, spec: templateSpec(entryId) }
		});
	} catch (error) {
		await failTemplateBuild(db, buildId, 'The build could not start.');
		if (error instanceof ApiError) throw error;
		throw new ApiError('unprocessable', 'The build could not be started', {
			...(error instanceof EngineStartError ? { reason: error.code } : {})
		});
	}
	return { buildId };
}

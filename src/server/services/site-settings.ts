import type { DiscoveryDocument } from '@contracts/discovery';
import { discoveryDocumentSchema } from '@contracts/discovery';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { ApiError } from '../../shared/errors';
import { CONFIG_GROUPS, type Action, type ConfigGroup } from '../../shared/permissions';
import { toFields, type FieldDescriptor } from '../../shared/site-config/form';
import { isKvWritable, isOwnerOnly, SITE_CONFIG_REGISTRY } from '../../shared/site-config/registry';
import { maskSecret } from '../../shared/site-config/secrets';
import {
	CONFIG_GROUP_LABELS,
	type SettingsField,
	type SettingsView
} from '../../shared/site-config/view';
import { getRelease } from '../db/repos/releases';
import { getSiteDiscovery, upsertSiteDiscovery } from '../db/repos/site-discovery';
import { getReadySite, type SiteRecord } from '../db/repos/sites';
import type { Principal } from '../domain/authorize';
import { type EngineStartRequest } from '../integrations/engine';
import {
	DiscoveryError,
	fetchDiscovery,
	propertySchema,
	type DiscoveryRelease
} from '../integrations/site-discovery';
import { checkUrl, UrlGuardError, type FetchLike } from '../integrations/url-guard';
import { type AuditInput } from './audit';
import { principalActor, withOwnerToken, type CustodyDeps } from './owner-tokens';

export interface SiteSettingsServices {
	getDb: () => Promise<CollegeDBClient>;
	custody: () => Promise<CustodyDeps>;
	fetch: FetchLike;
	now: () => number;
	startOperation: (request: EngineStartRequest) => Promise<void>;
	audit: (orgId: string, input: AuditInput) => Promise<unknown>;
}

// unreviewed: a settings page reread within a minute shows the stored document, not a fresh read
export const SETTINGS_CACHE_MS = 60_000;

// discoveryDocumentSchema requires a value, so an unregistered release or an unknown data schema gets these
export const UNKNOWN_RELEASE_VERSION = 'unknown';
export const UNKNOWN_SCHEMA_VERSION = Number.MAX_SAFE_INTEGER;

const notBuilt = (what: string) => async (): Promise<never> => {
	throw new ApiError('not_built', `${what} is not available yet`);
};

function productionServices(): SiteSettingsServices {
	return {
		getDb: notBuilt('The site store'),
		custody: notBuilt('Secret custody'),
		fetch: (input, init) => fetch(input, init),
		now: () => Date.now(),
		startOperation: notBuilt('Starting an operation'),
		audit: notBuilt('The audit log')
	};
}

let installed = productionServices();

export function setSiteSettingsServices(over: Partial<SiteSettingsServices>): void {
	installed = { ...installed, ...over };
}

export function resetSiteSettingsServices(): void {
	installed = productionServices();
}

export function siteSettingsServices(): SiteSettingsServices {
	return installed;
}

const NO_ANSWER = 'The site did not answer, and no settings have been stored for it yet.';
const NO_RELEASE = 'This site has no release on record, so its settings cannot be read yet.';

const readOnlyReason = (
	key: string,
	permitted: ReadonlySet<Action>,
	group: ConfigGroup,
	owner: boolean
) => {
	if (key === 'PLAN') return 'The platform sets the plan, so it cannot change here.';
	if (!isKvWritable(key)) return 'This value is set at deploy time, so it cannot change here.';
	if (isOwnerOnly(key) && !owner) return 'Only the site owner can change this.';
	if (!permitted.has(`site.config.${group}.write`)) {
		return 'Your role can view this but not change it.';
	}
	return null;
};

function fieldOf(
	field: FieldDescriptor,
	permitted: ReadonlySet<Action>,
	owner: boolean
): SettingsField {
	const group = field.permission as ConfigGroup;
	const reason = readOnlyReason(field.key, permitted, group, owner);
	return {
		key: field.key,
		label: field.label,
		description: field.description ?? null,
		group,
		widget: field.widget,
		bounds: field.bounds,
		schema: field.schema,
		value: maskSecret(field.key, field.value ?? null),
		provenance: field.provenance as SettingsField['provenance'],
		danger: field.danger,
		editable: reason === null,
		readOnlyReason: reason
	};
}

// the principal's own permissions decide which groups and writes show; the document only supplies fields
function viewOf(
	doc: DiscoveryDocument,
	source: 'live' | 'stored',
	stale: boolean,
	observedAt: number,
	permitted: ReadonlySet<Action>,
	owner: boolean
): SettingsView {
	const fields = toFields(doc.settings, 'viewer').map((f) => fieldOf(f, permitted, owner));
	return {
		state: 'ready',
		source,
		stale,
		observedAt: new Date(observedAt).toISOString(),
		reason: null,
		etag: doc.settings.etag,
		groups: visibleGroups(fields, permitted),
		redirects: doc.redirects
	};
}

function visibleGroups(
	fields: SettingsField[],
	permitted: ReadonlySet<Action>
): SettingsView['groups'] {
	return CONFIG_GROUPS.filter((id) => permitted.has(`site.config.${id}.read`)).map((id) => ({
		id,
		label: CONFIG_GROUP_LABELS[id],
		fields: fields.filter((f) => f.group === id)
	}));
}

// a site that is not Drupal has no live document, so the registry describes its settings without values
function registryView(permitted: ReadonlySet<Action>, owner: boolean): SettingsView {
	const schema: DiscoveryDocument['settings']['schema'] = {};
	for (const [key, entry] of Object.entries(SITE_CONFIG_REGISTRY)) {
		schema[key] = propertySchema(key, entry.domain, entry.permission, entry);
	}
	const settings = { schema, values: {}, provenance: {}, writable: {}, etag: 'registry' };
	const fields = toFields(settings, 'viewer').map((f) => fieldOf(f, permitted, owner));
	return {
		state: 'fallback',
		source: 'registry',
		stale: false,
		observedAt: null,
		reason: null,
		etag: null,
		groups: visibleGroups(fields, permitted),
		redirects: []
	};
}

function emptyView(reason: string): SettingsView {
	return {
		state: 'empty',
		source: null,
		stale: false,
		observedAt: null,
		reason,
		etag: null,
		groups: [],
		redirects: []
	};
}

function parseStored(document: unknown): DiscoveryDocument | null {
	const parsed = discoveryDocumentSchema.safeParse(document);
	return parsed.success ? parsed.data : null;
}

async function releaseOf(
	db: CollegeDBClient,
	releaseId: string,
	dataSchemaVersion: number | null
): Promise<DiscoveryRelease> {
	const registered = await getRelease(db, releaseId);
	return {
		version: registered?.version ?? UNKNOWN_RELEASE_VERSION,
		releaseId,
		schemaVersion: dataSchemaVersion ?? UNKNOWN_SCHEMA_VERSION
	};
}

async function readLive(
	services: SiteSettingsServices,
	site: SiteRecord,
	principal: Principal,
	release: DiscoveryRelease
): Promise<DiscoveryDocument> {
	if (site.primaryHostname === null) throw new DiscoveryError('unreachable', 'no hostname');
	const origin = checkUrl(`https://${site.primaryHostname}`).origin;
	return withOwnerToken(
		await services.custody(),
		{ siteId: site.id, actor: principalActor(principal), operation: 'settings.read' },
		(ownerToken) =>
			fetchDiscovery({ origin, ownerToken, siteId: site.id, release }, services.fetch)
	);
}

// the stored document is the cache; a live read that fails falls back to it, marked stale
async function documentOf(
	services: SiteSettingsServices,
	site: SiteRecord,
	principal: Principal,
	fresh = false
): Promise<{
	doc: DiscoveryDocument;
	source: 'live' | 'stored';
	stale: boolean;
	at: number;
} | null> {
	const db = await services.getDb();
	const now = services.now();
	const stored = await getSiteDiscovery(db, site.id);
	const storedDoc = stored === null ? null : parseStored(stored.document);
	if (stored !== null && storedDoc !== null && !fresh) {
		if (now - stored.fetchedAt < SETTINGS_CACHE_MS) {
			return { doc: storedDoc, source: 'stored', stale: false, at: stored.fetchedAt };
		}
	}
	const fallback =
		stored !== null && storedDoc !== null
			? { doc: storedDoc, source: 'stored' as const, stale: true, at: stored.fetchedAt }
			: null;
	if (!site.releaseId) return fallback;
	const release = await releaseOf(db, site.releaseId, site.dataSchemaVersion);
	try {
		const doc = await readLive(services, site, principal, release);
		await upsertSiteDiscovery(db, {
			siteId: site.id,
			document: doc,
			etag: doc.settings.etag,
			fetchedAt: now
		});
		return { doc, source: 'live', stale: false, at: now };
	} catch (error) {
		if (!(error instanceof DiscoveryError) && !(error instanceof UrlGuardError)) throw error;
		return fallback;
	}
}

export interface SiteSettingsInput {
	orgId: string;
	siteId: string;
	principal: Principal;
	// the actions the principal holds on this site, from permittedActions
	permitted: readonly Action[];
	// the principal holds an owner role in the organisation, which the owner-only settings need
	owner?: boolean;
	// skips the stored document, so a page right after a change shows the change
	fresh?: boolean;
}

export async function readSiteSettings(
	services: SiteSettingsServices,
	input: SiteSettingsInput
): Promise<SettingsView> {
	const site = await getReadySite(await services.getDb(), input.orgId, input.siteId);
	if (site === null) throw new ApiError('not_found', 'Not found');
	const permitted = new Set(input.permitted);

	const owner = input.owner === true;
	if (site.kind !== 'drupal') return registryView(permitted, owner);
	const found = await documentOf(services, site, input.principal, input.fresh === true);
	if (found === null) return emptyView(site.releaseId ? NO_ANSWER : NO_RELEASE);
	return viewOf(found.doc, found.source, found.stale, found.at, permitted, owner);
}

// the site's settings read right now, for a write to compare against; null when the site cannot be read
export async function freshDocument(
	services: SiteSettingsServices,
	site: SiteRecord,
	principal: Principal
): Promise<DiscoveryDocument | null> {
	const found = await documentOf(services, site, principal, true);
	return found !== null && found.source === 'live' ? found.doc : null;
}

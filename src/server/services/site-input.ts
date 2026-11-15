import { canonicalJson, sha256Digest } from '@contracts/common';
import {
	hostname as hostnameSchema,
	scriptName,
	SITE_KINDS,
	type SiteCategory,
	type SiteKind,
	type SitePlane
} from '@contracts/sites';
import { chooseConfig } from '../../../engine/src/config-choice';
import type { SiteCall } from '../../../engine/src/ports';
import type { SiteCreateInput } from '../../../engine/src/workflows/site-create';
import { isReserved, isValidName, suggest } from '../../shared/names';
import { workersDevHost } from '../../shared/plane-connections';
import type { Recipe } from '../../shared/recipes';
import { derive, FREE_PLAN_ID, siteLimits } from '../domain/entitlements';

export const MANAGED_HOST_SUFFIX = 'drupflare.app';

// the dispatch Worker compares only the hash of the rule; this is the document a new site starts with
export const DEFAULT_PUBLIC_ACCESS_RULE = { version: 1, access: 'public' } as const;

export const SITE_INPUT_ERRORS = [
	'unsupported_plane',
	'no_recipe',
	'no_account',
	'no_release',
	'unusable_plan',
	'bad_label',
	'first_run_input_missing',
	'no_connection',
	'connection_invalid',
	'no_subdomain',
	'bad_hostname'
] as const;

// shown on the create screen when the config is the canonical one on a customer account
export const NO_STORAGE_NOTE =
	'Your Cloudflare account has no object storage turned on, so this site runs without file mirroring and Strata off-site backups.';
export type SiteInputErrorCode = (typeof SITE_INPUT_ERRORS)[number];

export class SiteInputError extends Error {
	readonly code: SiteInputErrorCode;

	constructor(code: SiteInputErrorCode, message: string) {
		super(message);
		this.name = 'SiteInputError';
		this.code = code;
	}
}

export interface SiteInputConfig {
	hostSuffix: string;
	// appended to the label, so staging sites read <name>-staging.<suffix>
	labelSuffix?: string;
	// the Cloudflare account the managed plane creates sites in
	accountId: string | null;
	// the release a new site of each kind starts from
	releases: Partial<Record<SiteKind, string>>;
	// weekly test restores of each site's newest backup; on unless RESTORE_DRILLS is off
	restoreDrills?: boolean;
}

const textOf = (env: Record<string, unknown>, name: string): string | undefined => {
	const value = env[name];
	return typeof value === 'string' && value !== '' ? value : undefined;
};

// MANAGED_ACCOUNT_ID, MANAGED_HOST_SUFFIX, MANAGED_LABEL_SUFFIX and one RELEASE_<KIND> per kind; an unset one stays unset
export function siteInputConfigOf(env: Record<string, unknown>): SiteInputConfig {
	const releases: Partial<Record<SiteKind, string>> = {};
	for (const kind of SITE_KINDS) {
		const id = textOf(env, `RELEASE_${kind.toUpperCase()}`);
		if (id !== undefined) releases[kind] = id;
	}
	const labelSuffix = textOf(env, 'MANAGED_LABEL_SUFFIX') ?? '';
	if (labelSuffix !== '' && !/^-[a-z0-9]+$/.test(labelSuffix)) {
		throw new Error('MANAGED_LABEL_SUFFIX must be a hyphen and lowercase letters or digits');
	}
	return {
		hostSuffix: textOf(env, 'MANAGED_HOST_SUFFIX') ?? MANAGED_HOST_SUFFIX,
		labelSuffix,
		accountId: textOf(env, 'MANAGED_ACCOUNT_ID') ?? null,
		releases,
		restoreDrills: textOf(env, 'RESTORE_DRILLS') !== 'off'
	};
}

export interface SiteInputParts {
	site: {
		id: string;
		name: string;
		kind: SiteKind;
		category: SiteCategory;
		plane: SitePlane;
		// the requested hostname label; a suggested name stands in when there is none
		label: string | undefined;
	};
	organization: { id: string; planId: string };
	operation: { id: string };
	recipe: Recipe | undefined;
	// the configured current release for this kind
	release: string | undefined;
	account: string | null | undefined;
	// the stored Cloudflare connection a self-managed site is created through
	connection?: {
		state: 'active' | 'invalid' | 'revoked';
		accountId: string;
		capabilities: readonly { id: string; state: string }[];
		workersSubdomain: string | null;
	};
	// a hostname on a zone the owner holds, with the zone id they gave
	customHost?: { hostname: string; zoneId: string };
	hostSuffix?: string;
	labelSuffix?: string;
	ownerEmail?: string;
	// an environment or scratch label carries a suffix or prefix the names table reserves
	reservedOk?: boolean;
}

const clip = (value: string, max: number | undefined) =>
	max === undefined ? value : value.slice(0, max);

// only required fields are filled, and never the password: the site makes its own. The admin
// email is the one optional field sent whenever the owner's address is known, so the site's own
// password reset mail reaches them
function firstRunCall(
	recipe: Recipe,
	siteName: string,
	ownerEmail: string | undefined
): SiteCall | undefined {
	const { firstRun } = recipe;
	if (firstRun === null) return undefined;
	const body: Record<string, string> = {};
	for (const field of firstRun.body) {
		if (field.value === 'admin-password') continue;
		if (!field.required) {
			if (field.value === 'admin-email' && ownerEmail !== undefined) {
				body[field.name] = ownerEmail;
			}
			continue;
		}
		if (field.value === 'admin-username') body[field.name] = 'admin';
		else if (field.value === 'owner-input') body[field.name] = clip(siteName, field.maxLength);
		else if (ownerEmail !== undefined) body[field.name] = ownerEmail;
		else {
			throw new SiteInputError(
				'first_run_input_missing',
				`the ${recipe.id} first-run call needs ${field.name}, which is not known yet`
			);
		}
	}
	return {
		method: firstRun.method,
		path: firstRun.path,
		body: JSON.stringify(body),
		expectStatus: firstRun.success.statuses[0],
		reads: {
			adminPassword: 'adminPass',
			...(firstRun.admin === undefined
				? {}
				: { adminName: firstRun.admin.nameField, adminMail: firstRun.admin.mailField }),
			...(firstRun.ownerToken === undefined
				? {}
				: { ownerToken: firstRun.ownerToken.responseField })
		}
	};
}

// refuses before anything is written, so a site that cannot be created leaves no row behind
export async function buildSiteCreateInput(parts: SiteInputParts): Promise<SiteCreateInput> {
	const { site, organization, operation, recipe, release, connection } = parts;
	if (site.plane === 'self-hosted') {
		throw new SiteInputError(
			'unsupported_plane',
			`sites on the ${site.plane} plane are not created here`
		);
	}
	const own = site.plane === 'self-managed';
	if (recipe === undefined) {
		throw new SiteInputError('no_recipe', `there is no recipe for ${site.kind}`);
	}
	const account = own ? connection?.accountId : parts.account;
	if (own && connection === undefined) {
		throw new SiteInputError('no_connection', 'connect a Cloudflare account first');
	}
	if (own && connection?.state !== 'active') {
		throw new SiteInputError(
			'connection_invalid',
			'the Cloudflare connection is not valid; check it and try again'
		);
	}
	if (account === undefined || account === null || account === '') {
		throw new SiteInputError('no_account', 'no managed account is configured');
	}
	if (release === undefined || release === '') {
		throw new SiteInputError('no_release', `no current release is set for ${site.kind}`);
	}
	const plan = derive(organization.planId);
	if (!plan.ok) {
		throw new SiteInputError('unusable_plan', `the plan cannot be used: ${plan.reason}`);
	}
	const subdomain = own ? scriptName(site.id) : (site.label ?? suggest(site.id));
	const labelSuffix = parts.labelSuffix ?? '';
	if (
		!own &&
		(!isValidName(subdomain) ||
			(isReserved(subdomain) && parts.reservedOk !== true) ||
			subdomain.length + labelSuffix.length > 63)
	) {
		throw new SiteInputError('bad_label', `${subdomain} is not a usable hostname label`);
	}
	const firstRun = firstRunCall(recipe, site.name, parts.ownerEmail);
	// the storage reading decides the config; a customer account without it runs the canonical one
	const storageOn =
		connection?.capabilities.find((item) => item.id === 'storage')?.state === 'granted';
	const { config } = chooseConfig(
		own
			? {
					plane: 'self-managed',
					r2Enabled: storageOn,
					emailBindingAccepted: storageOn,
					attached: []
				}
			: { plane: 'managed', r2Enabled: true, emailBindingAccepted: true, attached: [] }
	);
	let hostname = `${subdomain}${labelSuffix}.${parts.hostSuffix ?? MANAGED_HOST_SUFFIX}`;
	let zoneId: string | undefined;
	if (own) {
		if (parts.customHost !== undefined) {
			if (!hostnameSchema.safeParse(parts.customHost.hostname).success) {
				throw new SiteInputError('bad_hostname', 'that is not a usable hostname');
			}
			hostname = parts.customHost.hostname;
			zoneId = parts.customHost.zoneId;
		} else if (connection?.workersSubdomain) {
			hostname = workersDevHost(subdomain, connection.workersSubdomain);
		} else {
			throw new SiteInputError(
				'no_subdomain',
				'your Cloudflare account has no workers.dev subdomain; set one in Cloudflare, or give a hostname on a domain you own'
			);
		}
	}
	const configNote = own && config === 'canonical' ? NO_STORAGE_NOTE : undefined;
	return {
		operationId: operation.id,
		site: {
			id: site.id,
			orgId: organization.id,
			name: site.name,
			kind: site.kind,
			category: site.category,
			plane: site.plane,
			config,
			ring: 'R0',
			plan: organization.planId,
			accountId: account
		},
		subdomain,
		hostname,
		...(zoneId === undefined ? {} : { zoneId }),
		...(configNote === undefined ? {} : { configNote }),
		releaseId: release,
		authority: {
			risk: organization.planId === FREE_PLAN_ID ? 'new-free' : 'established',
			limits: siteLimits(plan.entitlement),
			accessRuleHash: await sha256Digest(canonicalJson(DEFAULT_PUBLIC_ACCESS_RULE))
		},
		...(firstRun === undefined ? {} : { firstRun }),
		...(site.kind === 'custom'
			? {
					customResources: recipe.resources.flatMap((resource) =>
						resource.kind === 'send_email'
							? []
							: [{ kind: resource.kind, binding: resource.binding }]
					)
				}
			: {}),
		probe: {
			path: recipe.probe.path,
			expectStatus: 200,
			...(recipe.probe.auth === undefined ? {} : { auth: recipe.probe.auth })
		}
	};
}

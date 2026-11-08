import { canonicalJson, sha256Digest } from '@contracts/common';
import { SITE_KINDS, type SiteCategory, type SiteKind, type SitePlane } from '@contracts/sites';
import { chooseConfig } from '../../../engine/src/config-choice';
import type { SiteCall } from '../../../engine/src/ports';
import type { SiteCreateInput } from '../../../engine/src/workflows/site-create';
import { isReserved, isValidName, suggest } from '../../shared/names';
import type { Recipe } from '../../shared/recipes';
import { FREE_PLAN_ID, derive, siteLimits } from '../domain/entitlements';

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
	'first_run_input_missing'
] as const;
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
		releases
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
	hostSuffix?: string;
	labelSuffix?: string;
	ownerEmail?: string;
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
	const { site, organization, operation, recipe, release, account } = parts;
	if (site.plane !== 'managed') {
		throw new SiteInputError(
			'unsupported_plane',
			`sites on the ${site.plane} plane are not created here`
		);
	}
	if (recipe === undefined) {
		throw new SiteInputError('no_recipe', `there is no recipe for ${site.kind}`);
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
	const subdomain = site.label ?? suggest(site.id);
	const labelSuffix = parts.labelSuffix ?? '';
	if (
		!isValidName(subdomain) ||
		isReserved(subdomain) ||
		subdomain.length + labelSuffix.length > 63
	) {
		throw new SiteInputError('bad_label', `${subdomain} is not a usable hostname label`);
	}
	const firstRun = firstRunCall(recipe, site.name, parts.ownerEmail);
	const { config } = chooseConfig({
		plane: 'managed',
		r2Enabled: true,
		emailBindingAccepted: true,
		attached: []
	});
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
		hostname: `${subdomain}${labelSuffix}.${parts.hostSuffix ?? MANAGED_HOST_SUFFIX}`,
		releaseId: release,
		authority: {
			risk: organization.planId === FREE_PLAN_ID ? 'new-free' : 'established',
			limits: siteLimits(plan.entitlement),
			accessRuleHash: await sha256Digest(canonicalJson(DEFAULT_PUBLIC_ACCESS_RULE))
		},
		...(firstRun === undefined ? {} : { firstRun }),
		probe: {
			path: recipe.probe.path,
			expectStatus: 200,
			...(recipe.probe.auth === undefined ? {} : { auth: recipe.probe.auth })
		}
	};
}

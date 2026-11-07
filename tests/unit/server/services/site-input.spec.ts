import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Digest } from '../../../../contracts/src/common';
import { SITE_KINDS, categoryOfKind, type SiteKind } from '../../../../contracts/src/sites';
import { planSiteCreate } from '../../../../engine/src/workflows/site-create';
import { derive, siteLimits } from '../../../../src/server/domain/entitlements';
import {
	DEFAULT_PUBLIC_ACCESS_RULE,
	MANAGED_HOST_SUFFIX,
	SITE_INPUT_ERRORS,
	SiteInputError,
	buildSiteCreateInput,
	siteInputConfigOf,
	type SiteInputParts
} from '../../../../src/server/services/site-input';
import { isValidName, suggest } from '../../../../src/shared/names';
import { recipeFor } from '../../../../src/shared/recipes';

const ACCOUNT = 'a'.repeat(32);

function parts(kind: SiteKind, over: Partial<SiteInputParts> = {}): SiteInputParts {
	return {
		site: {
			id: 'site_abcdefgh12345678',
			name: 'Quiet Otter',
			kind,
			category: categoryOfKind(kind),
			plane: 'managed',
			label: 'quiet-otter'
		},
		organization: { id: 'org_abcdefgh12345678', planId: 'managed-free' },
		operation: { id: 'op_abcdefgh12345678' },
		recipe: recipeFor(kind),
		release: 'v1.0.4',
		account: ACCOUNT,
		...over
	};
}

const refusal = (input: SiteInputParts) =>
	buildSiteCreateInput(input).then(
		() => null,
		(error: unknown) => error
	);

describe('buildSiteCreateInput for each kind', () => {
	it.each(['drupal', 'nuxtpress', 'mylora'] as const)(
		'builds a managed create for %s from its recipe',
		async (kind) => {
			const recipe = recipeFor(kind)!;
			const input = await buildSiteCreateInput(parts(kind));
			expect(input).toMatchObject({
				operationId: 'op_abcdefgh12345678',
				subdomain: 'quiet-otter',
				hostname: `quiet-otter.${MANAGED_HOST_SUFFIX}`,
				releaseId: 'v1.0.4',
				site: {
					id: 'site_abcdefgh12345678',
					orgId: 'org_abcdefgh12345678',
					kind,
					category: categoryOfKind(kind),
					plane: 'managed',
					config: 'managed',
					accountId: ACCOUNT,
					plan: 'managed-free'
				},
				probe: { path: recipe.probe.path, expectStatus: 200 }
			});
			expect(input.firstRun).toMatchObject({
				method: 'POST',
				path: recipe.firstRun!.path,
				expectStatus: recipe.firstRun!.success.statuses[0]
			});
			const token = recipe.firstRun!.ownerToken;
			const admin = recipe.firstRun!.admin;
			expect(input.firstRun?.reads).toEqual({
				adminPassword: 'adminPass',
				...(admin === undefined
					? {}
					: { adminName: admin.nameField, adminMail: admin.mailField }),
				...(token === undefined ? {} : { ownerToken: token.responseField })
			});
			// the engine refuses a call that carries the password field
			expect(JSON.parse(input.firstRun!.body!)).not.toHaveProperty('adminPass');
			expect(planSiteCreate(input).steps.map((step) => step.id)).toContain('first-run');
		}
	);

	it('fills required fields only, and clips the site name to the field length', async () => {
		const input = await buildSiteCreateInput(
			parts('nuxtpress', { site: { ...parts('nuxtpress').site, name: 'n'.repeat(63) } })
		);
		expect(JSON.parse(input.firstRun!.body!)).toEqual({
			username: 'admin',
			displayName: 'n'.repeat(50)
		});
	});

	it('asks the probe for the owner token when the recipe says so', async () => {
		const drupal = await buildSiteCreateInput(parts('drupal'));
		expect(drupal.probe).toEqual({ path: '/health', expectStatus: 200, auth: 'owner-token' });
		const nuxtpress = await buildSiteCreateInput(parts('nuxtpress'));
		expect(nuxtpress.probe).not.toHaveProperty('auth');
	});

	it('needs an owner email for a recipe that requires one, and uses it when given', async () => {
		const missing = await refusal(parts('smoke'));
		expect(missing).toMatchObject({ code: 'first_run_input_missing' });
		const input = await buildSiteCreateInput(
			parts('smoke', { ownerEmail: 'owner@example.com' })
		);
		expect(JSON.parse(input.firstRun!.body!)).toMatchObject({ email: 'owner@example.com' });
	});

	it('sends the owner email as the Drupal admin mail, and never a site mail or admin name', async () => {
		const input = await buildSiteCreateInput(
			parts('drupal', { ownerEmail: 'owner@example.com' })
		);
		expect(JSON.parse(input.firstRun!.body!)).toEqual({ adminMail: 'owner@example.com' });
		expect(input.firstRun?.reads).toMatchObject({
			adminName: 'adminName',
			adminMail: 'adminMail'
		});
	});

	it('leaves the optional admin mail out when the owner email is not known', async () => {
		const input = await buildSiteCreateInput(parts('drupal'));
		expect(JSON.parse(input.firstRun!.body!)).toEqual({});
	});

	it('refuses the custom kind, which has no recipe of its own', async () => {
		expect(await refusal(parts('custom'))).toMatchObject({ code: 'no_recipe' });
	});

	it('covers every site kind: built, or refused with a typed code', async () => {
		for (const kind of SITE_KINDS) {
			const outcome = await refusal(parts(kind));
			if (outcome !== null) expect(outcome).toBeInstanceOf(SiteInputError);
		}
	});
});

describe('buildSiteCreateInput for each plane', () => {
	it('builds the managed plane', async () => {
		expect((await buildSiteCreateInput(parts('drupal'))).site.plane).toBe('managed');
	});

	it.each(['self-managed', 'self-hosted'] as const)('refuses the %s plane', async (plane) => {
		const base = parts('drupal');
		expect(await refusal({ ...base, site: { ...base.site, plane } })).toMatchObject({
			code: 'unsupported_plane'
		});
	});
});

describe('buildSiteCreateInput name, plan and authority', () => {
	it('uses the requested label and the configured suffix', async () => {
		const input = await buildSiteCreateInput(
			parts('drupal', { hostSuffix: 'sites.example.net' })
		);
		expect(input.hostname).toBe('quiet-otter.sites.example.net');
	});

	it('proposes the same suggested name for the same site when no label is requested', async () => {
		const base = parts('drupal');
		const first = await buildSiteCreateInput({
			...base,
			site: { ...base.site, label: undefined }
		});
		const second = await buildSiteCreateInput({
			...base,
			site: { ...base.site, label: undefined }
		});
		expect(first.subdomain).toBe(suggest(base.site.id));
		expect(second.subdomain).toBe(first.subdomain);
		expect(isValidName(first.subdomain)).toBe(true);
		expect(first.hostname).toBe(`${first.subdomain}.${MANAGED_HOST_SUFFIX}`);
	});

	it('marks a free site new-free and a paid site established', async () => {
		const free = await buildSiteCreateInput(parts('drupal'));
		const paid = await buildSiteCreateInput(
			parts('drupal', {
				organization: { id: 'org_abcdefgh12345678', planId: 'managed-site' }
			})
		);
		expect(free.authority.risk).toBe('new-free');
		expect(paid.authority.risk).toBe('established');
		expect(paid.site.plan).toBe('managed-site');
	});

	it('takes the limits from the plan data and the rule hash from the default public rule', async () => {
		const plan = derive('managed-free');
		if (!plan.ok) throw new Error(plan.reason);
		const input = await buildSiteCreateInput(parts('drupal'));
		expect(input.authority.limits).toEqual(siteLimits(plan.entitlement));
		expect(input.authority.accessRuleHash).toBe(
			await sha256Digest(canonicalJson(DEFAULT_PUBLIC_ACCESS_RULE))
		);
	});

	it('gives the engine a plan whose steps and digest are stable for one input', async () => {
		const first = planSiteCreate(await buildSiteCreateInput(parts('drupal')));
		const second = planSiteCreate(await buildSiteCreateInput(parts('drupal')));
		expect(second).toEqual(first);
		expect(first.targetIds).toEqual(['site_abcdefgh12345678']);
	});
});

describe('buildSiteCreateInput refusals', () => {
	it.each([null, undefined, ''])('refuses a missing managed account (%s)', async (account) => {
		expect(await refusal(parts('drupal', { account }))).toMatchObject({ code: 'no_account' });
	});

	it.each([undefined, ''])('refuses a kind with no current release (%s)', async (release) => {
		expect(await refusal(parts('drupal', { release }))).toMatchObject({ code: 'no_release' });
	});

	it('refuses a plan it cannot derive', async () => {
		const unknown = await refusal(
			parts('drupal', {
				organization: { id: 'org_abcdefgh12345678', planId: 'no-such-plan' }
			})
		);
		expect(unknown).toMatchObject({ code: 'unusable_plan' });
		const disabled = await refusal(
			parts('drupal', {
				organization: { id: 'org_abcdefgh12345678', planId: 'gmux-compute' }
			})
		);
		expect(disabled).toMatchObject({ code: 'unusable_plan' });
	});

	it.each(['Bad Label', 'admin', 'a--b', 'ab'])('refuses the label %s', async (label) => {
		const base = parts('drupal');
		expect(await refusal({ ...base, site: { ...base.site, label } })).toMatchObject({
			code: 'bad_label'
		});
	});

	it('trips every typed error once', async () => {
		const base = parts('drupal');
		const seen = new Set<string>();
		const outcomes = await Promise.all([
			refusal({ ...base, site: { ...base.site, plane: 'self-hosted' } }),
			refusal(parts('custom')),
			refusal(parts('drupal', { account: null })),
			refusal(parts('drupal', { release: undefined })),
			refusal(
				parts('drupal', { organization: { id: 'org_abcdefgh12345678', planId: 'nope' } })
			),
			refusal({ ...base, site: { ...base.site, label: 'admin' } }),
			refusal(parts('smoke'))
		]);
		for (const outcome of outcomes) seen.add((outcome as SiteInputError).code);
		expect([...seen].sort()).toEqual([...SITE_INPUT_ERRORS].sort());
	});
});

describe('siteInputConfigOf', () => {
	it('reads the account, the suffix and one release per kind', () => {
		const config = siteInputConfigOf({
			MANAGED_ACCOUNT_ID: ACCOUNT,
			MANAGED_HOST_SUFFIX: 'sites.example.net',
			RELEASE_DRUPAL: 'v1.0.4',
			RELEASE_SMOKE: 'v2'
		});
		expect(config).toEqual({
			hostSuffix: 'sites.example.net',
			accountId: ACCOUNT,
			releases: { drupal: 'v1.0.4', smoke: 'v2' }
		});
	});

	it('leaves an unset or empty name unset and falls back to the default suffix', () => {
		expect(
			siteInputConfigOf({ MANAGED_ACCOUNT_ID: '', RELEASE_DRUPAL: '', RELEASE_MYLORA: 5 })
		).toEqual({
			hostSuffix: MANAGED_HOST_SUFFIX,
			accountId: null,
			releases: {}
		});
	});
});

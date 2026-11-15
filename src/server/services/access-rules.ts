import { newId } from '@contracts/common';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { z } from 'zod';
import { planAccessSync, type AccessSyncInput } from '../../../engine/src/workflows/access-sync';
import {
	ACCESS_PRESET_IDS,
	ACCESS_PRESETS,
	hashLinkToken,
	hashPassword,
	INVITEE_LIMITS,
	presetUnlocked,
	type AccessPresetId,
	type AccessRule
} from '../../shared/access-presets';
import { ApiError } from '../../shared/errors';
import { findPlan } from '../../shared/plans';
import {
	accessSyncState,
	createAccessRule,
	listAccessRules,
	revokeAccessRule,
	type AccessRuleRecord
} from '../db/repos/access-rules';
import { getEnvironment } from '../db/repos/environments';
import { getReadySite } from '../db/repos/sites';
import type { Principal } from '../domain/authorize';
import type { EngineStartRequest } from '../integrations/engine';
import type { AuditInput } from './audit';
import { newOperation, startAndReturn } from './backups';
import { randomToken } from './crypto';
import { principalActor } from './owner-tokens';

export interface AccessServices {
	getDb: () => Promise<CollegeDBClient>;
	planOf: (orgId: string) => Promise<string>;
	// starts the operation that writes the new digests to the site; the lease carries them within one interval
	startOperation: (request: EngineStartRequest) => Promise<void>;
	audit: (orgId: string, input: AuditInput) => Promise<unknown>;
	now: () => number;
}

const notBuilt = (what: string) => async (): Promise<never> => {
	throw new ApiError('not_built', `${what} is not available yet`);
};

function productionServices(): AccessServices {
	return {
		getDb: notBuilt('The site store'),
		planOf: notBuilt('The plan lookup'),
		startOperation: notBuilt('Updating who can open a site'),
		audit: notBuilt('The audit log'),
		now: () => Date.now()
	};
}

let installed = productionServices();

export function setAccessServices(over: Partial<AccessServices>): void {
	installed = { ...installed, ...over };
}

export function resetAccessServices(): void {
	installed = productionServices();
}

export function accessServices(): AccessServices {
	return installed;
}

// unreviewed: a review link lives a week unless the caller picks fewer hours
export const DEFAULT_REVIEW_LINK_HOURS = 168;
export const MAX_REVIEW_LINK_HOURS = 720;

// #region views

export const ruleViewSchema = z.strictObject({
	id: z.string(),
	environment: z.string(),
	preset: z.enum(ACCESS_PRESET_IDS),
	values: z.array(z.string()),
	expiresAt: z.number().int().nullable(),
	createdBy: z.string(),
	createdAt: z.number().int()
});

export type RuleView = z.infer<typeof ruleViewSchema>;

const VALUE_KEYS: Partial<Record<AccessPresetId, string>> = {
	'email-invite': 'emails',
	'github-user': 'users',
	'gitlab-user': 'users',
	'github-org': 'orgs',
	'gitlab-group': 'groups'
};

// hashes and salts never leave the server
export function toRuleView(rule: AccessRuleRecord): RuleView {
	const key = VALUE_KEYS[rule.preset];
	const raw = key === undefined ? undefined : rule.config[key];
	const expires = rule.config.expiresAt;
	return {
		id: rule.id,
		environment: rule.environment,
		preset: rule.preset,
		values: Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [],
		expiresAt: typeof expires === 'number' ? expires : null,
		createdBy: rule.createdBy,
		createdAt: rule.createdAt
	};
}

export const accessViewSchema = z.strictObject({
	rules: z.array(ruleViewSchema),
	// false while a change is still being applied to the site, and when applying it failed
	activeOnSite: z.boolean(),
	presets: z.array(
		z.strictObject({
			id: z.enum(ACCESS_PRESET_IDS),
			label: z.string(),
			available: z.boolean(),
			unlockedBy: z.string().nullable()
		})
	),
	inviteeLimit: z.int().nullable()
});

export const syncedSchema = z.strictObject({ operationId: z.string() });

export const addedRuleSchema = z.strictObject({
	rule: ruleViewSchema,
	linkToken: z.string().optional(),
	operationId: z.string()
});

// #endregion

function inviteeLimit(planId: string): number | null {
	const limits = INVITEE_LIMITS as Record<string, { value: number }>;
	return limits[planId]?.value ?? null;
}

function planName(id: string): string {
	return findPlan(id)?.name ?? id;
}

async function requireSite(db: CollegeDBClient, orgId: string, siteId: string): Promise<void> {
	if ((await getReadySite(db, orgId, siteId)) === null) {
		throw new ApiError('not_found', 'Not found');
	}
}

function toRules(records: readonly AccessRuleRecord[]): AccessRule[] {
	return records.map((rule) => ({
		id: rule.id,
		environment: rule.environment,
		preset: rule.preset,
		config: rule.config
	}));
}

const notPickedUp = () =>
	new ApiError(
		'conflict',
		'Your change is saved, but the site has not picked it up yet. Try again in a minute.',
		{ saved: true }
	);

// starts the operation that writes the digests of the active rules and live environments to the
// site; the rule rows are already saved, so a failed start leaves them in place
export async function syncSiteAccess(
	s: AccessServices,
	orgId: string,
	siteId: string
): Promise<{ operationId: string }> {
	const db = await s.getDb();
	const site = await getReadySite(db, orgId, siteId);
	if (site === null) throw new ApiError('not_found', 'Not found');
	if (site.state !== 'active' || site.accountId === null) throw notPickedUp();
	const params: AccessSyncInput = {
		operationId: newId('op'),
		orgId,
		siteId,
		accountId: site.accountId
	};
	try {
		const { operation } = await newOperation(db, {
			id: params.operationId,
			orgId,
			accountId: site.accountId,
			siteId,
			type: 'access.sync',
			plan: planAccessSync(params),
			idempotencyKey: `access-${params.operationId}`,
			inputs: params
		});
		await startAndReturn(
			s,
			db,
			operation,
			{
				workflow: 'access-sync',
				id: params.operationId,
				params: params as unknown as Record<string, unknown>
			},
			orgId
		);
	} catch (error) {
		if (error instanceof ApiError && error.code === 'not_built') throw error;
		throw notPickedUp();
	}
	return { operationId: params.operationId };
}

export async function readSiteAccess(
	s: AccessServices,
	input: { orgId: string; siteId: string }
): Promise<z.infer<typeof accessViewSchema>> {
	const db = await s.getDb();
	await requireSite(db, input.orgId, input.siteId);
	const [records, planId, state] = await Promise.all([
		listAccessRules(db, input.orgId, input.siteId),
		s.planOf(input.orgId),
		accessSyncState(db, input.orgId, input.siteId)
	]);
	const caughtUp =
		state.changedAt === 0 || (state.syncedAt !== null && state.syncedAt >= state.changedAt);
	return {
		rules: records.map(toRuleView),
		activeOnSite: caughtUp,
		presets: ACCESS_PRESETS.map((preset) => {
			const unlocked = presetUnlocked(preset.id, planId);
			return {
				id: preset.id,
				label: preset.label,
				available: unlocked.ok,
				unlockedBy: unlocked.ok ? null : planName(unlocked.unlockedBy)
			};
		}),
		inviteeLimit: inviteeLimit(planId)
	};
}

// #region adding and removing

const text = z.string().trim().min(1).max(200);

export const addRuleSchema = z.strictObject({
	environment: z.string().min(1).max(64),
	preset: z.enum(ACCESS_PRESET_IDS),
	values: z.array(text).max(500).optional(),
	password: z.string().min(8).max(200).optional(),
	expiresInHours: z.int().min(1).max(MAX_REVIEW_LINK_HOURS).optional()
});

export type AddRuleInput = z.infer<typeof addRuleSchema>;

async function configFor(
	input: AddRuleInput,
	now: number
): Promise<{ config: Record<string, unknown>; linkToken?: string }> {
	const key = VALUE_KEYS[input.preset];
	if (key !== undefined) {
		if (!input.values || input.values.length === 0) {
			throw new ApiError(
				'validation',
				'Add at least one name or address for this access type'
			);
		}
		const values = [...new Set(input.values.map((value) => value.toLowerCase()))];
		return { config: { [key]: values } };
	}
	if (input.preset === 'password') {
		if (input.password === undefined) throw new ApiError('validation', 'Choose a password');
		const salt = randomToken(16);
		return { config: { salt, passwordHash: await hashPassword(input.password, salt) } };
	}
	if (input.preset === 'review-link') {
		const hours = input.expiresInHours ?? DEFAULT_REVIEW_LINK_HOURS;
		const linkToken = randomToken(32);
		return {
			config: {
				tokenHash: await hashLinkToken(linkToken),
				expiresAt: now + hours * 3_600_000
			},
			linkToken
		};
	}
	return { config: {} };
}

export async function addAccessRule(
	s: AccessServices,
	input: { orgId: string; siteId: string; principal: Principal; body: AddRuleInput }
): Promise<{ rule: RuleView; linkToken?: string; operationId: string }> {
	const { body } = input;
	const db = await s.getDb();
	await requireSite(db, input.orgId, input.siteId);
	const planId = await s.planOf(input.orgId);
	const unlocked = presetUnlocked(body.preset, planId);
	if (!unlocked.ok) {
		throw new ApiError(
			'forbidden',
			`This access type needs the ${planName(unlocked.unlockedBy)} plan`,
			{ unlockedBy: unlocked.unlockedBy }
		);
	}
	if (body.environment !== 'prod') {
		const found = await getEnvironment(db, input.orgId, input.siteId, body.environment);
		if (found === null) throw new ApiError('validation', 'That environment does not exist');
	}
	const now = s.now();
	const { config, linkToken } = await configFor(body, now);
	if (body.preset === 'email-invite') {
		const limit = inviteeLimit(planId);
		const held = (await listAccessRules(db, input.orgId, input.siteId))
			.filter((rule) => rule.preset === 'email-invite')
			.flatMap((rule) => (Array.isArray(rule.config.emails) ? rule.config.emails : []));
		const total = new Set([...held, ...(config.emails as string[])]).size;
		if (limit !== null && total > limit) {
			throw new ApiError('conflict', `Your plan allows ${limit} invited addresses per site`, {
				limit
			});
		}
	}
	const record = await createAccessRule(db, {
		id: `rule_${randomToken(12)}`,
		organizationId: input.orgId,
		siteId: input.siteId,
		environment: body.environment,
		preset: body.preset,
		config,
		createdBy: principalActor(input.principal),
		createdAt: now
	});
	await s.audit(input.orgId, {
		actor: principalActor(input.principal),
		action: 'site.access.rule.add',
		target: input.siteId,
		detail: { ruleId: record.id, environment: record.environment, preset: record.preset }
	});
	const { operationId } = await syncSiteAccess(s, input.orgId, input.siteId);
	return {
		rule: toRuleView(record),
		...(linkToken === undefined ? {} : { linkToken }),
		operationId
	};
}

export async function removeAccessRule(
	s: AccessServices,
	input: { orgId: string; siteId: string; ruleId: string; principal: Principal }
): Promise<{ operationId: string }> {
	const db = await s.getDb();
	await requireSite(db, input.orgId, input.siteId);
	const revoked = await revokeAccessRule(db, input.orgId, input.siteId, input.ruleId, s.now());
	if (!revoked) throw new ApiError('not_found', 'Not found');
	await s.audit(input.orgId, {
		actor: principalActor(input.principal),
		action: 'site.access.rule.remove',
		target: input.siteId,
		detail: { ruleId: input.ruleId }
	});
	return syncSiteAccess(s, input.orgId, input.siteId);
}

// #endregion

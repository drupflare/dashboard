import { canonicalJson, sha256Digest } from '@contracts/common';
import { z } from 'zod';

export const ACCESS_PRESET_IDS = [
	'members',
	'grants',
	'email-invite',
	'github-user',
	'gitlab-user',
	'github-org',
	'gitlab-group',
	'sso',
	'password',
	'review-link',
	'public'
] as const;

const accessPresetSchema = z.object({
	id: z.enum(ACCESS_PRESET_IDS),
	label: z.string().min(1),
	unlockedBy: z.literal('institution-standard').nullable(),
	source: z.string().min(1)
});

const SAME_EVERYWHERE = 'owner decision 2026-11-14; same on every plan, invitees are the meter';

type AccessPreset = z.infer<typeof accessPresetSchema>;

export const ACCESS_PRESETS: readonly AccessPreset[] = z.array(accessPresetSchema).parse([
	{
		id: 'members',
		label: 'Members',
		unlockedBy: null,
		source: 'plan:418; plan states no tier'
	},
	{
		id: 'grants',
		label: 'Grants',
		unlockedBy: null,
		source: 'plan:419; plan states no tier'
	},
	{
		id: 'email-invite',
		label: 'Email Invite',
		unlockedBy: null,
		source: SAME_EVERYWHERE
	},
	{
		id: 'github-user',
		label: 'GitHub User',
		unlockedBy: null,
		source: SAME_EVERYWHERE
	},
	{
		id: 'gitlab-user',
		label: 'GitLab User',
		unlockedBy: null,
		source: 'plan:421; plan states no tier'
	},
	{
		id: 'github-org',
		label: 'GitHub Organisation',
		unlockedBy: null,
		source: 'plan:422; plan states no tier'
	},
	{
		id: 'gitlab-group',
		label: 'GitLab Group',
		unlockedBy: null,
		source: 'plan:422; plan states no tier'
	},
	{
		id: 'sso',
		label: 'Single Sign-On',
		unlockedBy: 'institution-standard',
		source: 'plan:423; roadmap:271 SSO in Standard'
	},
	{
		id: 'password',
		label: 'Shared Password',
		unlockedBy: null,
		source: 'plan:424; plan states no tier'
	},
	{
		id: 'review-link',
		label: 'Review Link',
		unlockedBy: null,
		source: SAME_EVERYWHERE
	},
	{
		id: 'public',
		label: 'Public',
		unlockedBy: null,
		source: 'plan:426 default for prod; plan states no tier'
	}
]);

// #region evaluation

export type AccessPresetId = (typeof ACCESS_PRESET_IDS)[number];

export type AccessRule = {
	id: string;
	environment: string;
	preset: AccessPresetId;
	config: Record<string, unknown>;
};

// every field is a fact the Gate already proved; a missing field means the proof is absent
export type Visitor = {
	now: number;
	member?: boolean;
	grant?: boolean;
	email?: string;
	github?: { user: string; orgs: string[] };
	gitlab?: { user: string; groups: string[] };
	sso?: boolean;
	password?: string;
	linkToken?: string;
};

export type AccessDecision = { allow: boolean; reason: string };

const PBKDF2_ROUNDS = 100_000;
const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function same(a: string, b: string): boolean {
	let diff = a.length ^ b.length;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	}
	return diff === 0;
}

export async function hashPassword(password: string, salt: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
		'deriveBits'
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: PBKDF2_ROUNDS },
		key,
		256
	);
	return hex(new Uint8Array(bits));
}

export async function hashLinkToken(token: string): Promise<string> {
	return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))));
}

function list(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function lower(values: string[]): string[] {
	return values.map((value) => value.toLowerCase());
}

async function matches(rule: AccessRule, visitor: Visitor): Promise<boolean> {
	const config = rule.config;
	switch (rule.preset) {
		case 'public':
			return true;
		case 'members':
			return visitor.member === true;
		case 'grants':
			return visitor.grant === true;
		case 'email-invite':
			return (
				visitor.email !== undefined &&
				lower(list(config.emails)).includes(visitor.email.toLowerCase())
			);
		case 'github-user':
			return (
				visitor.github !== undefined &&
				lower(list(config.users)).includes(visitor.github.user.toLowerCase())
			);
		case 'gitlab-user':
			return (
				visitor.gitlab !== undefined &&
				lower(list(config.users)).includes(visitor.gitlab.user.toLowerCase())
			);
		case 'github-org': {
			const orgs = lower(visitor.github?.orgs ?? []);
			return lower(list(config.orgs)).some((org) => orgs.includes(org));
		}
		case 'gitlab-group': {
			const groups = lower(visitor.gitlab?.groups ?? []);
			return lower(list(config.groups)).some((group) => groups.includes(group));
		}
		case 'sso':
			return visitor.sso === true;
		case 'password': {
			const { salt, passwordHash } = config;
			if (typeof salt !== 'string' || typeof passwordHash !== 'string') return false;
			if (visitor.password === undefined) return false;
			return same(await hashPassword(visitor.password, salt), passwordHash);
		}
		case 'review-link': {
			const { tokenHash, expiresAt } = config;
			if (typeof tokenHash !== 'string' || typeof expiresAt !== 'number') return false;
			if (visitor.linkToken === undefined || visitor.now >= expiresAt) return false;
			return same(await hashLinkToken(visitor.linkToken), tokenHash);
		}
	}
}

// rules combine as any-of; no rules on a private environment means nobody gets in
export async function evaluateAccess(
	rules: readonly AccessRule[],
	visitor: Visitor
): Promise<AccessDecision> {
	if (rules.length === 0) return { allow: false, reason: 'no-rules' };
	for (const rule of rules) {
		if (await matches(rule, visitor)) return { allow: true, reason: rule.preset };
	}
	return { allow: false, reason: 'no-match' };
}

// only single sign-on is tied to a plan; every other preset is open and the invitee count is metered
export function presetUnlocked(
	preset: AccessPresetId,
	planId: string
): { ok: true } | { ok: false; unlockedBy: string } {
	const needed = ACCESS_PRESETS.find((item) => item.id === preset)?.unlockedBy ?? null;
	return needed === null || planId === needed ? { ok: true } : { ok: false, unlockedBy: needed };
}

// #endregion

// #region hashing

export const PUBLIC_RULE_HASH_INPUT = { version: 1, access: 'public' } as const;

// canonical and order independent: the rules sort by their canonical form before hashing
export function ruleHash(rules: readonly AccessRule[], environment = ''): Promise<string> {
	const sorted = rules.map((rule) => canonicalJson(rule)).sort();
	return sha256Digest(canonicalJson({ version: 1, environment, rules: sorted }));
}

// prod is public unless a rule says otherwise; every other environment is private by default
export async function accessGates(
	environments: readonly string[],
	rules: readonly AccessRule[]
): Promise<{ accessRuleHash: string; gates: Record<string, string> }> {
	const gates: Record<string, string> = {};
	for (const environment of new Set(['prod', ...environments])) {
		const own = rules.filter((rule) => rule.environment === environment);
		const open = own.some((rule) => rule.preset === 'public');
		const gated = environment === 'prod' ? own.length > 0 && !open : !open;
		if (gated) gates[environment] = await ruleHash(own, environment);
	}
	const accessRuleHash =
		Object.keys(gates).length === 0
			? await sha256Digest(canonicalJson(PUBLIC_RULE_HASH_INPUT))
			: await sha256Digest(canonicalJson(gates));
	return { accessRuleHash, gates };
}

// #endregion

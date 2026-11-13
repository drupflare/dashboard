import type { CollegeDBClient } from '@earth-app/collegedb';
import type { KeyCreateBody, KeyCreated, KeyView } from '../../shared/api-keys';
import { ApiError } from '../../shared/errors';
import { ACTIONS, type Action } from '../../shared/permissions';
import { createApiKeyWithLookup, listLookupIds } from '../db/repos/api-key-lookup';
import {
	countActiveApiKeys,
	getApiKey,
	listApiKeys,
	revokeApiKey,
	type ApiKey
} from '../db/repos/organization';
import { authorize, type Facts, type Principal } from '../domain/authorize';
import { keyUsable, validateIssue, type IssueError } from '../domain/scopes';
import { toPage, type Page } from '../utils/pagination';
import { generateApiKey } from './api-keys';
import type { AuditInput } from './audit';
import { principalActor } from './owner-tokens';

export interface KeyServices {
	getDb: () => Promise<CollegeDBClient>;
	audit: (orgId: string, input: AuditInput) => Promise<unknown>;
	now: () => number;
}

let installed: KeyServices | null = null;

export function setKeyServices(services: KeyServices | null): void {
	installed = services;
}

export function keyServices(): KeyServices {
	if (installed === null) throw new ApiError('not_built', 'API keys are not available yet');
	return installed;
}

// a technical bound that keeps one organisation's key table small, not a plan limit; the number is
// a placeholder until a plan limit replaces it
export const ACTIVE_KEY_BOUND = 100;

// site actions are checked against some site, and an organisation role holds them on every site
const ANY_SITE = '*';

// #region issue

// the actions the issuer holds in this organisation right now, narrowed to what a key can carry
export function issuerActions(
	principal: Principal,
	orgId: string,
	facts: Facts
): ReadonlySet<Action> {
	const held = new Set<Action>();
	for (const action of ACTIONS) {
		if (!keyUsable(action)) continue;
		const decision = authorize({
			principal,
			action,
			resource: { orgId, siteId: ANY_SITE },
			facts
		});
		if (decision.allow) held.add(action);
	}
	return held;
}

const REFUSALS: Record<IssueError, string> = {
	empty: 'Pick at least one permission for the key',
	unknown_scope: 'One of the permissions you picked does not exist',
	session_only: 'A key cannot hold one of the permissions you picked. Remove it and try again',
	step_up_only: 'A key cannot hold one of the permissions you picked. Remove it and try again',
	exceeds_issuer: 'You cannot give a key a permission you do not hold yourself'
};

function toView(key: ApiKey, prefix: string | null): KeyView {
	const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());
	return {
		id: key.id,
		name: key.name,
		prefix,
		scopes: key.scopes,
		createdAt: new Date(key.createdAt).toISOString(),
		lastUsedAt: iso(key.lastUsedAt),
		expiresAt: iso(key.expiresAt),
		revokedAt: iso(key.revokedAt)
	};
}

export async function issueKey(
	deps: KeyServices,
	call: { orgId: string; userId: string; principal: Principal; facts: Facts; body: KeyCreateBody }
): Promise<KeyCreated> {
	const checked = validateIssue(
		call.body.scopes,
		issuerActions(call.principal, call.orgId, call.facts)
	);
	if (!checked.ok) {
		const status = checked.reason === 'exceeds_issuer' ? 'forbidden' : 'validation';
		throw new ApiError(status, REFUSALS[checked.reason], {
			reason: checked.reason,
			...(checked.scope === undefined ? {} : { scope: checked.scope })
		});
	}

	const db = await deps.getDb();
	const now = deps.now();
	if ((await countActiveApiKeys(db, call.orgId, now)) >= ACTIVE_KEY_BOUND) {
		throw new ApiError(
			'conflict',
			'This organization has as many active keys as it can hold. Revoke one you no longer use',
			{ reason: 'key_bound' }
		);
	}

	const generated = await generateApiKey({
		scopes: checked.scopes,
		expiry: call.body.expiry,
		now
	});
	const key = await createApiKeyWithLookup(db, call.orgId, {
		name: call.body.name,
		keyHash: generated.data.keyHash,
		scopes: generated.data.scopes,
		createdBy: call.userId,
		expiresAt: generated.data.expiresAt,
		lookupId: generated.data.lookupId
	});
	// a key with no audit row would be one nobody can account for, so it dies with the failed write
	try {
		await deps.audit(call.orgId, {
			actor: principalActor(call.principal),
			action: 'key.issued',
			target: key.id,
			detail: { prefix: generated.data.displayPrefix, scopes: key.scopes }
		});
	} catch (error) {
		await revokeApiKey(db, call.orgId, key.id, now);
		throw error;
	}
	return { ...toView(key, generated.data.displayPrefix), token: generated.token };
}

// #endregion

// #region read and revoke

async function viewsOf(
	deps: KeyServices,
	orgId: string,
	keys: readonly ApiKey[]
): Promise<KeyView[]> {
	const prefixes = await listLookupIds(
		await deps.getDb(),
		orgId,
		keys.map((key) => key.id)
	);
	return keys.map((key) => {
		const lookup = prefixes.get(key.id);
		return toView(key, lookup === undefined ? null : `dfk_${lookup}`);
	});
}

export async function listKeys(
	deps: KeyServices,
	orgId: string,
	options: { after?: { createdAt: number; id: string }; limit: number }
): Promise<Page<KeyView>> {
	const rows = await listApiKeys(await deps.getDb(), orgId, {
		after: options.after,
		count: options.limit + 1
	});
	const page = toPage(rows, options.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
	return { items: await viewsOf(deps, orgId, page.items), nextCursor: page.nextCursor };
}

// revoking a key that is already revoked changes nothing and returns it as it stands
export async function revokeKey(deps: KeyServices, orgId: string, id: string): Promise<KeyView> {
	const db = await deps.getDb();
	await revokeApiKey(db, orgId, id, deps.now());
	const key = await getApiKey(db, orgId, id);
	if (key === null) throw new ApiError('not_found', 'Not found');
	const [view] = await viewsOf(deps, orgId, [key]);
	return view!;
}

// #endregion

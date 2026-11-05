import { actionDef, isAction, isSessionOnly, type Action } from '../../shared/permissions';

export interface ApiKeyFacts {
	id: string;
	scopes: readonly string[];
	orgIds?: readonly string[];
	siteIds?: readonly string[];
	expiresAt?: number;
	revokedAt?: number;
}

export type KeyDenial = 'key_revoked' | 'key_expired' | 'session_only' | 'key_scope';

export type IssueError =
	'empty' | 'unknown_scope' | 'session_only' | 'step_up_only' | 'exceeds_issuer';

export type IssueResult =
	{ ok: true; scopes: Action[] } | { ok: false; reason: IssueError; scope?: string };

// a key can never present a step-up, so those actions are refused at issue and at use
export function keyUsable(action: Action): boolean {
	return !isSessionOnly(action) && actionDef(action).stepUp !== true;
}

export function validateIssue(
	requested: readonly string[],
	issuerActions: ReadonlySet<Action>
): IssueResult {
	if (requested.length === 0) return { ok: false, reason: 'empty' };
	const scopes: Action[] = [];
	for (const scope of requested) {
		if (!isAction(scope)) return { ok: false, reason: 'unknown_scope', scope };
		if (isSessionOnly(scope)) return { ok: false, reason: 'session_only', scope };
		if (!keyUsable(scope)) return { ok: false, reason: 'step_up_only', scope };
		if (!issuerActions.has(scope)) return { ok: false, reason: 'exceeds_issuer', scope };
		scopes.push(scope);
	}
	return { ok: true, scopes: [...new Set(scopes)] };
}

// what a key can do right now: its scopes narrowed by what the issuer still holds
export function effectiveScopes(
	scopes: readonly string[],
	issuerActions: ReadonlySet<Action>
): Action[] {
	return scopes.filter((s): s is Action => isAction(s) && keyUsable(s) && issuerActions.has(s));
}

export function keyAllows(
	key: ApiKeyFacts,
	action: Action,
	resource: { orgId?: string; siteId?: string } | undefined,
	now: number
): KeyDenial | null {
	if (key.revokedAt !== undefined && key.revokedAt <= now) return 'key_revoked';
	if (key.expiresAt !== undefined && key.expiresAt <= now) return 'key_expired';
	if (isSessionOnly(action)) return 'session_only';
	if (!key.scopes.includes(action)) return 'key_scope';
	if (key.orgIds && resource?.orgId !== undefined && !key.orgIds.includes(resource.orgId)) {
		return 'key_scope';
	}
	if (key.siteIds) {
		const siteScoped = actionDef(action).scope === 'site';
		if (
			!siteScoped ||
			resource?.siteId === undefined ||
			!key.siteIds.includes(resource.siteId)
		) {
			return 'key_scope';
		}
	}
	return null;
}

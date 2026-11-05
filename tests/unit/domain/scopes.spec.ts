import { describe, expect, it } from 'vitest';
import { permittedActions } from '../../../src/server/domain/authorize';
import {
	effectiveScopes,
	keyAllows,
	keyUsable,
	validateIssue
} from '../../../src/server/domain/scopes';
import { ACTIONS, ORG_ROLES, isSessionOnly, type Action } from '../../../src/shared/permissions';
import { facts, fresh, member, resource, user } from './fixtures';

const issuer = (...actions: Action[]) => new Set<Action>(actions);

describe('validateIssue', () => {
	it('accepts a subset of the issuer actions', () => {
		const r = validateIssue(
			['site.read', 'site.deploy', 'site.read'],
			issuer('site.read', 'site.deploy')
		);
		expect(r).toEqual({ ok: true, scopes: ['site.read', 'site.deploy'] });
	});

	it('trips every error once', () => {
		const held = issuer(...ACTIONS);
		expect(validateIssue([], held)).toEqual({ ok: false, reason: 'empty' });
		expect(validateIssue(['nope'], held)).toEqual({
			ok: false,
			reason: 'unknown_scope',
			scope: 'nope'
		});
		expect(validateIssue(['key.create'], held)).toEqual({
			ok: false,
			reason: 'session_only',
			scope: 'key.create'
		});
		expect(validateIssue(['site.delete'], held)).toEqual({
			ok: false,
			reason: 'step_up_only',
			scope: 'site.delete'
		});
		expect(validateIssue(['site.deploy'], issuer('site.read'))).toEqual({
			ok: false,
			reason: 'exceeds_issuer',
			scope: 'site.deploy'
		});
	});

	it('refuses every session-only action as a scope', () => {
		for (const a of ACTIONS.filter(isSessionOnly)) {
			expect(validateIssue([a], issuer(...ACTIONS)).ok, a).toBe(false);
		}
	});

	it('never accepts an action the issuing role lacks', () => {
		for (const role of ORG_ROLES) {
			const held = new Set(
				permittedActions({
					principal: user,
					resource,
					facts: facts({ ...member(role), ...fresh })
				})
			);
			for (const a of ACTIONS) {
				const r = validateIssue([a], held);
				if (r.ok) expect(held.has(a), `${role} ${a}`).toBe(true);
			}
		}
	});
});

describe('effectiveScopes', () => {
	it('narrows the scopes to what the issuer still holds', () => {
		const scopes = ['site.read', 'site.deploy', 'bogus', 'key.create'];
		expect(effectiveScopes(scopes, issuer('site.read', 'key.create'))).toEqual(['site.read']);
		expect(effectiveScopes(scopes, issuer())).toEqual([]);
	});
});

describe('keyAllows', () => {
	const key = { id: 'k', scopes: ['site.read', 'org.read'] };
	const res = { orgId: 'o1', siteId: 's1' };

	it('passes a scoped action and trips every denial once', () => {
		expect(keyAllows(key, 'site.read', res, 10)).toBeNull();
		expect(keyAllows({ ...key, revokedAt: 10 }, 'site.read', res, 10)).toBe('key_revoked');
		expect(keyAllows({ ...key, expiresAt: 10 }, 'site.read', res, 10)).toBe('key_expired');
		expect(keyAllows(key, 'key.create', res, 10)).toBe('session_only');
		expect(keyAllows(key, 'site.deploy', res, 10)).toBe('key_scope');
		expect(keyAllows({ ...key, orgIds: ['o2'] }, 'site.read', res, 10)).toBe('key_scope');
		expect(keyAllows({ ...key, siteIds: ['s2'] }, 'site.read', res, 10)).toBe('key_scope');
		expect(keyAllows({ ...key, siteIds: ['s1'] }, 'org.read', res, 10)).toBe('key_scope');
		expect(keyAllows({ ...key, siteIds: ['s1'] }, 'site.read', undefined, 10)).toBe(
			'key_scope'
		);
	});

	it('reports a revoked key before a scope miss', () => {
		expect(keyAllows({ ...key, revokedAt: 1 }, 'key.create', res, 10)).toBe('key_revoked');
	});
});

describe('keyUsable', () => {
	it('excludes session-only, step-up and admin actions', () => {
		expect(keyUsable('site.read')).toBe(true);
		expect(keyUsable('key.create')).toBe(false);
		expect(keyUsable('site.transfer')).toBe(false);
		expect(keyUsable('admin.aggregates.read')).toBe(false);
	});
});

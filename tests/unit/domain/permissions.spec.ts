import { describe, expect, it } from 'vitest';
import {
	ACTIONS,
	ACTION_DEFS,
	BASTION_ROLES,
	CONFIG_GROUPS,
	ORG_ROLES,
	ORG_ROLE_ACTIONS,
	SESSION_ONLY_ACTIONS,
	SITE_ROLES,
	SITE_ROLE_ACTIONS,
	actionDef,
	isAction,
	isOrgRole,
	isSessionOnly,
	isSiteRole
} from '../../../src/shared/permissions';

describe('permissions table', () => {
	it('gives the owner every action any other organisation role has', () => {
		const owner = new Set(ORG_ROLE_ACTIONS.owner);
		for (const role of ORG_ROLES) {
			for (const action of ORG_ROLE_ACTIONS[role]) expect(owner.has(action)).toBe(true);
		}
	});

	it('gives the owner every action a site role has', () => {
		const owner = new Set(ORG_ROLE_ACTIONS.owner);
		for (const role of SITE_ROLES) {
			for (const action of SITE_ROLE_ACTIONS[role]) expect(owner.has(action)).toBe(true);
		}
	});

	it('keeps the site roles nested: viewer within maintainer within site-admin', () => {
		const admin = new Set(SITE_ROLE_ACTIONS['site-admin']);
		const maintainer = new Set(SITE_ROLE_ACTIONS.maintainer);
		for (const a of SITE_ROLE_ACTIONS.maintainer) expect(admin.has(a)).toBe(true);
		for (const a of SITE_ROLE_ACTIONS.viewer) expect(maintainer.has(a)).toBe(true);
	});

	it('keeps maintainer away from delete, domains, collaborators and the owner token', () => {
		const m = SITE_ROLE_ACTIONS.maintainer;
		for (const a of [
			'site.delete',
			'site.domain.manage',
			'site.domain.read',
			'site.domain.rename',
			'site.grant.manage',
			'site.owner-token.reveal'
		] as const) {
			expect(m).not.toContain(a);
		}
		for (const a of [
			'site.deploy',
			'site.rollback',
			'site.upgrade',
			'site.pull',
			'site.modify',
			'site.heal'
		] as const) {
			expect(m).toContain(a);
		}
	});

	it('lets a developer change appearance and not security', () => {
		expect(ORG_ROLE_ACTIONS.developer).toContain('site.config.appearance.write');
		expect(ORG_ROLE_ACTIONS.developer).not.toContain('site.config.security.write');
	});

	it('defines read and write for every configuration group', () => {
		for (const group of CONFIG_GROUPS) {
			expect(isAction(`site.config.${group}.read`)).toBe(true);
			expect(isAction(`site.config.${group}.write`)).toBe(true);
		}
	});

	it('names every action as resource.verb', () => {
		for (const action of ACTIONS) expect(action).toMatch(/^[a-z-]+(\.[a-z-]+)+$/);
	});

	it('flags the four named session-only actions and every admin action', () => {
		for (const a of [
			'key.create',
			'billing.portal',
			'site.owner-token.reveal',
			'org.delete'
		] as const) {
			expect(SESSION_ONLY_ACTIONS).toContain(a);
		}
		for (const a of ACTIONS) {
			if (actionDef(a).scope === 'admin') expect(isSessionOnly(a)).toBe(true);
		}
	});

	it('marks no admin action as site content and no admin action as org-role held', () => {
		for (const a of ACTIONS) {
			const def = actionDef(a);
			if (def.scope !== 'admin') continue;
			expect(def.content).toBeUndefined();
			expect(def.org).toBeUndefined();
			expect(def.platform).toBeDefined();
		}
	});

	it('maps site roles to bastion roles and never to operator', () => {
		expect(BASTION_ROLES['site-admin']).toBe('tenant-admin');
		expect(BASTION_ROLES.maintainer).toBe('tenant-admin');
		expect(BASTION_ROLES.viewer).toBe('tenant-viewer');
		expect(Object.values(BASTION_ROLES)).not.toContain('operator');
	});

	it('only offers site roles on site-scope actions', () => {
		for (const a of ACTIONS) {
			const def = ACTION_DEFS[a] as { scope: string; site?: unknown };
			if (def.site) expect(def.scope).toBe('site');
		}
	});

	it('guards the role and action type checks', () => {
		expect(isOrgRole('owner')).toBe(true);
		expect(isOrgRole('constructor')).toBe(false);
		expect(isSiteRole('maintainer')).toBe(true);
		expect(isSiteRole(undefined)).toBe(false);
		expect(isAction('toString')).toBe(false);
		expect(isAction('site.deploy')).toBe(true);
	});
});

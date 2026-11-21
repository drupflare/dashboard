import { describe, expect, it } from 'vitest';
import {
	assignableRoles,
	canAssignRole,
	canManageMember,
	INVITABLE_ROLES,
	sitePreviewLine
} from '../../../src/shared/members';

describe('canAssignRole', () => {
	it('never hands out the owner role', () => {
		expect(canAssignRole('owner', 'owner')).toBe(false);
	});

	it('lets only an owner hand out admin', () => {
		expect(canAssignRole('owner', 'admin')).toBe(true);
		expect(canAssignRole('admin', 'admin')).toBe(false);
	});

	it('refuses a role whose actions the inviter does not hold', () => {
		expect(canAssignRole('admin', 'billing')).toBe(false);
		expect(canAssignRole('developer', 'viewer')).toBe(true);
	});
});

describe('canManageMember', () => {
	it('keeps a member above the actor out of reach', () => {
		expect(canManageMember('admin', 'owner')).toBe(false);
		expect(canManageMember('owner', 'owner')).toBe(true);
	});
});

describe('assignableRoles', () => {
	it('offers no role an owner could not give, and never owner', () => {
		for (const actor of ['owner', 'admin', 'developer', 'billing', 'viewer'] as const) {
			const offered = assignableRoles(actor);
			expect(offered).not.toContain('owner');
			for (const role of offered) expect(INVITABLE_ROLES).toContain(role);
		}
	});
});

describe('sitePreviewLine', () => {
	it('derives what a role can do from the permission table', () => {
		expect(sitePreviewLine('site-admin')).toContain('manage collaborators');
		expect(sitePreviewLine('viewer')).toContain('cannot deploy');
		expect(sitePreviewLine('site-admin')).not.toContain('cannot');
	});
});

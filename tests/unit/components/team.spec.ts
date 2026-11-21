import { mountSuspended } from '@nuxt/test-utils/runtime';
import { DOMWrapper, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TeamGrants from '~/components/team/Grants.vue';
import TeamInvites from '~/components/team/Invites.vue';
import TeamMembers from '~/components/team/Members.vue';
import DepartmentCreateDialog from '~/components/team/department/CreateDialog.vue';
import InviteDialog from '~/components/team/invite/Dialog.vue';
import PermissionMatrix from '~/components/team/permission/Matrix.vue';
import RolePicker from '~/components/team/role/Picker.vue';
import {
	assignableRoles,
	INVITE_TTL_DAYS,
	sitePreviewLine,
	type InviteView,
	type MemberView,
	type SiteGrantView
} from '~/shared/members';
import { useMembersStore } from '~/stores/members';
import { calls, clearBrowserState, failure, registerApi } from '../stores/store-support';

const ORG = 'org_campus';
const SITE = 'site_abcdefghijklmnopqrst';
const grantsPath = `/api/v1/orgs/${ORG}/sites/${SITE}/grants`;
const mounted: { unmount: () => void }[] = [];
const stubs: (() => void)[] = [];

const stub = (routes: Parameters<typeof registerApi>[0]) => stubs.push(registerApi(routes));

const member = (over: Partial<MemberView>): MemberView => ({
	id: 'mem_1',
	userId: 'usr_1',
	email: 'ada@example.test',
	displayName: 'Ada',
	role: 'admin',
	joinedAt: '2026-02-01T00:00:00.000Z',
	...over
});

const roster: MemberView[] = [
	member({}),
	member({
		id: 'mem_2',
		userId: 'usr_2',
		email: 'grace@example.test',
		displayName: null,
		role: 'viewer'
	})
];

async function mountMembers(actorRole: 'owner' | 'admin' | 'viewer') {
	const wrapper = await mountSuspended(TeamMembers, {
		props: { orgId: ORG, actorRole, members: roster }
	});
	mounted.push(wrapper);
	return wrapper;
}

beforeEach(() => {
	clearBrowserState();
	useMembersStore().$reset();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	stubs.splice(0).forEach((stop) => stop());
});

describe('team role picker', () => {
	it('names the control and offers only the roles it is given', async () => {
		const wrapper = await mountSuspended(RolePicker, {
			props: {
				modelValue: 'viewer',
				roles: ['viewer', 'developer'],
				label: 'Role for Grace'
			}
		});
		mounted.push(wrapper);
		expect(wrapper.find('[aria-label="Role for Grace"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('Viewer');
	});
});

describe('team permission matrix', () => {
	it('reads each area as All, Some or None, and the owner never reads narrower than a viewer', async () => {
		const owner = await mountSuspended(PermissionMatrix, { props: { role: 'owner' } });
		const viewer = await mountSuspended(PermissionMatrix, { props: { role: 'viewer' } });
		mounted.push(owner, viewer);
		const cells = (wrapper: typeof owner) =>
			wrapper.findAll('tbody td').map((cell) => cell.text());
		const ownerCells = cells(owner);
		const viewerCells = cells(viewer);
		expect(ownerCells.length).toBeGreaterThan(0);
		for (const cell of [...ownerCells, ...viewerCells]) {
			expect(['All', 'Some', 'None']).toContain(cell);
		}
		const none = (values: string[]) => values.filter((value) => value === 'None').length;
		expect(none(ownerCells)).toBeLessThanOrEqual(none(viewerCells));
	});
});

describe('team member list', () => {
	it('shows the remove control for a person who can manage members', async () => {
		const wrapper = await mountMembers('owner');
		expect(wrapper.find('[aria-label="Remove Ada"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('grace@example.test');
	});

	it('shows no remove control for a member whose role is above the viewer', async () => {
		const wrapper = await mountSuspended(TeamMembers, {
			props: { orgId: ORG, actorRole: 'viewer', members: [roster[0]!] }
		});
		mounted.push(wrapper);
		expect(wrapper.find('[aria-label="Remove Ada"]').exists()).toBe(false);
	});

	it('shows no remove control to a viewer for a viewer', async () => {
		const wrapper = await mountMembers('viewer');
		expect(wrapper.find('[aria-label="Remove grace@example.test"]').exists()).toBe(false);
	});

	it('shows no role picker to a viewer for another viewer, and one to an admin', async () => {
		const viewer = await mountMembers('viewer');
		expect(viewer.find('[aria-label="Role for grace@example.test"]').exists()).toBe(false);
		const admin = await mountMembers('admin');
		expect(admin.find('[aria-label="Role for grace@example.test"]').exists()).toBe(true);
	});

	it('asks before removing, and removes only after the person confirms', async () => {
		const stop = registerApi({
			[`DELETE /api/v1/orgs/${ORG}/members/mem_2`]: { status: 204, body: null }
		});
		const wrapper = await mountMembers('owner');
		await wrapper.find('[aria-label="Remove grace@example.test"]').trigger('click');
		expect(document.body.textContent).toContain('Remove This Member');
		expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
		stop();
	});
});

describe('team member offboarding', () => {
	it('offers Offboard to an admin for another member, never to the signed-in person', async () => {
		const wrapper = await mountSuspended(TeamMembers, {
			props: { orgId: ORG, actorRole: 'admin', members: roster, selfUserId: 'usr_1' }
		});
		mounted.push(wrapper);
		expect(wrapper.find('[aria-label="Offboard grace@example.test"]').exists()).toBe(true);
		expect(wrapper.find('[aria-label="Offboard Ada"]').exists()).toBe(false);
	});

	it('offers no Offboard to a viewer', async () => {
		const wrapper = await mountMembers('viewer');
		expect(wrapper.find('[aria-label^="Offboard"]').exists()).toBe(false);
	});
});

describe('department create dialog', () => {
	it('opens with no console error and offers the top level as a choice', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const wrapper = await mountSuspended(DepartmentCreateDialog, {
			props: { orgId: ORG, departments: [] }
		});
		mounted.push(wrapper);
		await wrapper.find('button').trigger('click');
		await flushPromises();
		expect(document.body.textContent).toContain('None (Top Level)');
		expect(errors).not.toHaveBeenCalled();
		errors.mockRestore();
	});
});

describe('team invitations', () => {
	const invite = (over: Partial<InviteView>): InviteView => ({
		id: 'inv_1',
		email: 'grace@example.test',
		role: 'viewer',
		expiresAt: '2026-12-01T00:00:00.000Z',
		createdAt: '2026-11-24T00:00:00.000Z',
		...over
	});
	const pending = [
		invite({}),
		invite({ id: 'inv_2', email: 'linus@example.test', role: 'developer' })
	];

	async function mountInvites(canManage: boolean) {
		const wrapper = await mountSuspended(TeamInvites, {
			props: { orgId: ORG, invites: pending, canManage }
		});
		mounted.push(wrapper);
		return wrapper;
	}

	it('lists each invitation with its role and the controls for a manager', async () => {
		const wrapper = await mountInvites(true);
		expect(wrapper.text()).toContain('linus@example.test');
		expect(wrapper.text()).toContain('Developer');
		expect(
			wrapper.find('[aria-label="Revoke the invitation to grace@example.test"]').exists()
		).toBe(true);
		expect(
			wrapper.find('[aria-label="Send the invitation to linus@example.test again"]').exists()
		).toBe(true);
	});

	it('shows no resend or revoke control to someone who cannot manage members', async () => {
		const wrapper = await mountInvites(false);
		expect(wrapper.text()).toContain('grace@example.test');
		expect(wrapper.find('[aria-label^="Revoke"]').exists()).toBe(false);
		expect(wrapper.find('[aria-label^="Send the invitation"]').exists()).toBe(false);
	});

	it('revokes an invitation through its route', async () => {
		stub({ [`POST /api/v1/orgs/${ORG}/invites/inv_1/revoke`]: { body: {} } });
		const wrapper = await mountInvites(true);
		await wrapper
			.find('[aria-label="Revoke the invitation to grace@example.test"]')
			.trigger('click');
		await flushPromises();
		expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(
			`POST /api/v1/orgs/${ORG}/invites/inv_1/revoke`
		);
	});

	it('resends an invitation through its route', async () => {
		stub({ [`POST /api/v1/orgs/${ORG}/invites/inv_2/resend`]: { body: {} } });
		const wrapper = await mountInvites(true);
		await wrapper
			.find('[aria-label="Send the invitation to linus@example.test again"]')
			.trigger('click');
		await flushPromises();
		expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(
			`POST /api/v1/orgs/${ORG}/invites/inv_2/resend`
		);
	});

	it('shows the server refusal when an invitation cannot be revoked', async () => {
		stub({
			[`POST /api/v1/orgs/${ORG}/invites/inv_1/revoke`]: failure(
				'invite.revoke_refused',
				'This invitation was already accepted.',
				'req_invite_1'
			)
		});
		const wrapper = await mountInvites(true);
		await wrapper
			.find('[aria-label="Revoke the invitation to grace@example.test"]')
			.trigger('click');
		await vi.waitFor(() => expect(wrapper.find('[role="alert"]').exists()).toBe(true));
		expect(wrapper.find('[role="alert"]').text()).toContain(
			'This invitation was already accepted.'
		);
	});
});

describe('team site grants', () => {
	const grant = (over: Partial<SiteGrantView>): SiteGrantView => ({
		id: 'grt_1',
		userId: 'usr_2',
		email: 'grace@example.test',
		displayName: 'Grace',
		role: 'maintainer',
		inOrganization: true,
		expiresAt: null,
		createdAt: '2026-02-01T00:00:00.000Z',
		...over
	});
	const current = [
		grant({}),
		grant({
			id: 'grt_2',
			userId: 'usr_3',
			email: 'linus@example.test',
			displayName: null,
			role: 'viewer',
			inOrganization: false
		})
	];

	async function mountGrants(canManage: boolean, grants: SiteGrantView[] = current) {
		const wrapper = await mountSuspended(TeamGrants, {
			props: { orgId: ORG, siteId: SITE, grants, canManage }
		});
		mounted.push(wrapper);
		return wrapper;
	}

	it('names each collaborator, their site role and whether they belong to the organisation', async () => {
		const wrapper = await mountGrants(true);
		expect(wrapper.text()).toContain('Grace');
		expect(wrapper.text()).toContain('linus@example.test');
		expect(wrapper.text()).toContain('In this organization');
		expect(wrapper.text()).toContain('Outside the organization');
		expect(wrapper.find('[aria-label="Site role for Grace"]').exists()).toBe(true);
	});

	it('shows read-only roles and no remove control to someone who cannot manage access', async () => {
		const wrapper = await mountGrants(false);
		expect(wrapper.text()).toContain('Maintainer');
		expect(wrapper.find('[aria-label^="Remove site access"]').exists()).toBe(false);
		expect(wrapper.find('form').exists()).toBe(false);
	});

	it('previews the effective permissions of the role chosen in the add form', async () => {
		const wrapper = await mountGrants(true);
		expect(wrapper.text()).toContain(`${sitePreviewLine('viewer')}.`);
	});

	it('asks for an email address before sending anything', async () => {
		stub({ [`POST ${grantsPath}`]: { body: {} } });
		const wrapper = await mountGrants(true);
		await wrapper.find('form').trigger('submit');
		await flushPromises();
		expect(wrapper.find('[role="alert"]').text()).toContain(
			'Enter the email address of the person to add.'
		);
		expect(calls.some((call) => call.method === 'POST')).toBe(false);
	});

	it('adds a collaborator with the trimmed address, the chosen role and no expiry', async () => {
		stub({ [`POST ${grantsPath}`]: { body: {} } });
		const wrapper = await mountGrants(true);
		await wrapper.find('#grant-email').setValue('  ada@example.test ');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() =>
			expect((wrapper.find('#grant-email').element as HTMLInputElement).value).toBe('')
		);
		const post = calls.find((call) => call.method === 'POST');
		expect(post?.path).toBe(grantsPath);
		expect(post?.body).toEqual({ email: 'ada@example.test', role: 'viewer', expiry: 'never' });
	});

	it('shows the server refusal when a collaborator cannot be added', async () => {
		stub({
			[`POST ${grantsPath}`]: failure(
				'site.grant.refused',
				'That person already has access to this site.',
				'req_grant_1'
			)
		});
		const wrapper = await mountGrants(true);
		await wrapper.find('#grant-email').setValue('ada@example.test');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() => expect(wrapper.find('[role="alert"]').exists()).toBe(true));
		expect(wrapper.find('[role="alert"]').text()).toContain(
			'That person already has access to this site.'
		);
	});

	it('removes a collaborator through the grants route', async () => {
		stub({ [`DELETE ${grantsPath}/grt_1`]: { status: 204, body: null } });
		const wrapper = await mountGrants(true);
		await wrapper.find('[aria-label="Remove site access for Grace"]').trigger('click');
		await flushPromises();
		expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(
			`DELETE ${grantsPath}/grt_1`
		);
	});
});

describe('team invite dialog', () => {
	async function openDialog(actorRole: 'owner' | 'admin') {
		const wrapper = await mountSuspended(InviteDialog, { props: { orgId: ORG, actorRole } });
		mounted.push(wrapper);
		await wrapper.find('button').trigger('click');
		await flushPromises();
		return wrapper;
	}
	const emailField = () => document.querySelector<HTMLInputElement>('#invite-email')!;
	const typeEmail = (value: string) => {
		emailField().value = value;
		emailField().dispatchEvent(new Event('input'));
	};
	const submitInvite = async () => {
		await new DOMWrapper(document.querySelector('form')!).trigger('submit');
		await flushPromises();
	};

	it('opens a dialog that says how long the invitation link lasts', async () => {
		await openDialog('owner');
		expect(document.body.textContent).toContain('Invite a Member');
		expect(document.body.textContent).toContain(`expires after ${INVITE_TTL_DAYS} days`);
	});

	it('offers an owner every role it may assign, never owner itself', async () => {
		const wrapper = await openDialog('owner');
		const roles = wrapper.findComponent(RolePicker).props('roles');
		expect(roles).toEqual(assignableRoles('owner'));
		expect(roles).not.toContain('owner');
	});

	it('offers an admin no admin role, since only an owner can hand that out', async () => {
		const wrapper = await openDialog('admin');
		const roles = wrapper.findComponent(RolePicker).props('roles');
		expect(roles).toEqual(assignableRoles('admin'));
		expect(roles).not.toContain('admin');
	});

	it('sends the invitation with the trimmed address and confirms it', async () => {
		stub({ [`POST /api/v1/orgs/${ORG}/invites`]: { status: 201, body: {} } });
		const wrapper = await openDialog('owner');
		typeEmail(' grace@example.test ');
		await submitInvite();
		const post = calls.find((call) => call.method === 'POST');
		expect(post?.body).toEqual({
			email: 'grace@example.test',
			role: assignableRoles('owner')[0]
		});
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain(
				'The invitation was sent to grace@example.test.'
			)
		);
		expect(wrapper.emitted('invited')).toHaveLength(1);
	});

	it('asks for an email address before sending anything', async () => {
		stub({ [`POST /api/v1/orgs/${ORG}/invites`]: { status: 201, body: {} } });
		await openDialog('owner');
		await submitInvite();
		expect(document.body.textContent).toContain(
			'Enter the email address of the person to invite.'
		);
		expect(calls.some((call) => call.method === 'POST')).toBe(false);
	});

	it('shows the server refusal and keeps the form open', async () => {
		stub({
			[`POST /api/v1/orgs/${ORG}/invites`]: failure(
				'invite.exists',
				'An invitation to that address is already pending.',
				'req_invite_2'
			)
		});
		const wrapper = await openDialog('owner');
		typeEmail('grace@example.test');
		await submitInvite();
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain(
				'An invitation to that address is already pending.'
			)
		);
		expect(wrapper.emitted('invited')).toBeUndefined();
	});
});

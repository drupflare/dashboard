import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DepartmentPage from '~/pages/org/departments/[id].vue';
import DepartmentsPage from '~/pages/org/departments/index.vue';
import type { DepartmentMemberView, DepartmentView, PlacementSite } from '~/shared/departments';
import { useDepartmentsStore } from '~/stores/departments';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import {
	calls,
	clearBrowserState,
	failure,
	registerApi,
	type Reply
} from '../stores/store-support';

const ORG = 'org_personal';
const listKey = `GET /api/v1/orgs/${ORG}/departments`;
const placeKey = `GET /api/v1/orgs/${ORG}/departments/sites`;
const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};

const dept = (id: string, over: Partial<DepartmentView> = {}): DepartmentView => ({
	id,
	parentId: null,
	name: `Name ${id}`,
	kind: 'department',
	siteQuota: null,
	ownSites: 0,
	subtreeSites: 0,
	childCount: 0,
	memberCount: 0,
	canManage: true,
	createdAt: '2026-11-01T10:00:00.000Z',
	...over
});

const person = (
	userId: string,
	over: Partial<DepartmentMemberView> = {}
): DepartmentMemberView => ({
	userId,
	email: `${userId}@example.test`,
	displayName: null,
	role: 'viewer',
	grantedAt: '2026-11-01T10:00:00.000Z',
	...over
});

let cleanup: () => void = () => undefined;
let listReply: () => Reply | Promise<Reply>;
let placements: PlacementSite[] = [];
let members: DepartmentMemberView[] = [];
let role = 'owner';
const mounted: { unmount: () => void }[] = [];

function api(extra: Record<string, Reply | ((call: never) => Reply)> = {}) {
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': {
			body: { items: [{ id: ORG, name: 'Personal', personal: true, role }], nextCursor: null }
		},
		[listKey]: () => listReply(),
		[placeKey]: () => ({ body: { items: placements } }),
		[`GET /api/v1/orgs/${ORG}/departments/dept_a/members`]: () => ({
			body: { items: members }
		}),
		...extra
	} as never);
}

async function mount(
	component: object,
	route: string,
	extra: Record<string, Reply | ((call: never) => Reply)> = {}
) {
	useOrgStore().$reset();
	api(extra);
	await useOrgStore().ensure();
	const wrapper = await mountSuspended(component, { route });
	mounted.push(wrapper);
	return wrapper;
}

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useDepartmentsStore().$reset();
	role = 'owner';
	placements = [];
	members = [];
	listReply = () => ({ body: { items: [], central: true } });
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	document.body.replaceChildren();
});

describe('departments page', () => {
	it('shows a skeleton until the list arrives, then the empty state and the create button', async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		listReply = async () => {
			await gate;
			return { body: { items: [], central: true } };
		};
		const wrapper = await mount(DepartmentsPage, '/org/departments');
		expect(wrapper.find('[role="status"]').text()).toBe('Loading departments');
		release();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Departments Yet'));
		expect(wrapper.text()).toContain('Create a department to give a team');
		expect(
			wrapper.findAll('button').some((button) => button.text() === 'Create a Department')
		).toBe(true);
	});

	it('hides the create button from someone who is not central IT and says who can create one', async () => {
		role = 'viewer';
		listReply = () => ({ body: { items: [], central: false } });
		const wrapper = await mount(DepartmentsPage, '/org/departments');
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Departments Yet'));
		expect(wrapper.text()).toContain('An organization owner or admin can create departments.');
		expect(wrapper.findAll('button').some((b) => b.text() === 'Create a Department')).toBe(
			false
		);
	});

	it('draws the tree with counts, limits and a link to each department', async () => {
		listReply = () => ({
			body: {
				central: true,
				items: [
					dept('dept_root', {
						name: 'Campus',
						kind: 'division',
						subtreeSites: 3,
						memberCount: 1
					}),
					dept('dept_a', {
						name: 'Library',
						parentId: 'dept_root',
						siteQuota: 5,
						subtreeSites: 2,
						memberCount: 4
					})
				]
			}
		});
		const wrapper = await mount(DepartmentsPage, '/org/departments');
		await vi.waitFor(() =>
			expect(wrapper.find('ul[aria-label="Departments"]').exists()).toBe(true)
		);
		const text = wrapper.find('ul[aria-label="Departments"]').text();
		expect(text).toContain('Campus');
		expect(text).toContain('Division');
		expect(text).toContain('3 Sites, No Limit');
		expect(text).toContain('2 of 5 Sites');
		const links = wrapper.findAll('a').map((a) => a.attributes('href'));
		expect(links).toContain('/org/departments/dept_a');
		expect(wrapper.find('ul ul').text()).toContain('Library');
	});

	it('shows an error with a retry that loads the list again', async () => {
		let healthy = false;
		listReply = () =>
			healthy
				? { body: { items: [dept('dept_a')], central: true } }
				: failure('internal', 'The service is down', 'req_9');
		const wrapper = await mount(DepartmentsPage, '/org/departments');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load Departments'));
		expect(wrapper.text()).toContain('req_9');
		healthy = true;
		await wrapper
			.findAll('button')
			.find((b) => b.text() === 'Try Again')!
			.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Name dept_a'));
	});

	it('says there is no organization when the list answers not found', async () => {
		listReply = () => ({ status: 404, body: failure('not_found', 'Not found', 'req_8').body });
		const wrapper = await mount(DepartmentsPage, '/org/departments');
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Organization Found'));
	});
});

describe('department page', () => {
	const open = (extra: Record<string, Reply | ((call: never) => Reply)> = {}) =>
		mount(DepartmentPage, '/org/departments/dept_a', extra);

	it('shows the department, its members and its sites', async () => {
		listReply = () => ({
			body: {
				central: true,
				items: [
					dept('dept_root', { name: 'Campus', kind: 'division' }),
					dept('dept_a', {
						name: 'Library',
						parentId: 'dept_root',
						siteQuota: 4,
						subtreeSites: 1
					})
				]
			}
		});
		members = [person('u1', { displayName: 'Ada Admin', role: 'admin' })];
		placements = [
			{ id: 'site_1', name: 'books', departmentId: 'dept_a' },
			{ id: 'site_2', name: 'elsewhere', departmentId: null }
		];
		const wrapper = await open();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Ada Admin'));
		expect(wrapper.find('h1').text()).toBe('Library');
		expect(wrapper.text()).toContain('1 of 4 Sites');
		expect(wrapper.find('nav[aria-label="Breadcrumb"]').text()).toContain('Campus');
		await vi.waitFor(() => expect(wrapper.text()).toContain('books'));
		expect(wrapper.text()).toContain('Move a Site Here');
		expect(wrapper.text()).toContain('Site Limit');
		expect(wrapper.text()).toContain('Delete Department');
	});

	it('leaves out limit, delete and the forms for someone who can only read', async () => {
		role = 'viewer';
		listReply = () => ({
			body: { central: false, items: [dept('dept_a', { name: 'Library', canManage: false })] }
		});
		members = [person('u1')];
		placements = [{ id: 'site_1', name: 'books', departmentId: 'dept_a' }];
		const wrapper = await open();
		await vi.waitFor(() => expect(wrapper.text()).toContain('u1@example.test'));
		const text = wrapper.text();
		expect(text).not.toContain('Delete Department');
		expect(text).not.toContain('Save Site Limit');
		expect(text).not.toContain('Add Member');
		expect(text).not.toContain('Move a Site Here');
		expect(wrapper.findAll('button').some((b) => b.text() === 'Remove')).toBe(false);
		await vi.waitFor(() => expect(wrapper.text()).toContain('books'));
	});

	it('answers a department that is not in this organization with not found', async () => {
		listReply = () => ({ body: { central: true, items: [dept('dept_other')] } });
		const wrapper = await open();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Department Not Found'));
	});

	it('sends a valid Site Limit and refuses a bad one without a request', async () => {
		listReply = () => ({
			body: { central: true, items: [dept('dept_a', { name: 'Library' })] }
		});
		const wrapper = await open({
			[`PUT /api/v1/orgs/${ORG}/departments/dept_a/quota`]: {
				body: dept('dept_a', { siteQuota: 7 })
			}
		});
		const quotaForm = () =>
			wrapper.findAll('form').find((f) => f.find('input[inputmode="numeric"]').exists())!;
		await vi.waitFor(() => expect(wrapper.text()).toContain('Save Site Limit'));
		const input = wrapper.find('input[inputmode="numeric"]');
		await input.setValue('abc');
		await quotaForm().trigger('submit');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Enter a whole number from 0 to'));
		expect(calls.some((c) => c.method === 'PUT')).toBe(false);
		await input.setValue('7');
		await quotaForm().trigger('submit');
		await vi.waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
		expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ siteQuota: 7 });
	});

	it('adds a member by email and shows a refusal from the server', async () => {
		listReply = () => ({
			body: { central: true, items: [dept('dept_a', { name: 'Library' })] }
		});
		let refuse = false;
		const wrapper = await open({
			[`POST /api/v1/orgs/${ORG}/departments/dept_a/members`]: () =>
				refuse
					? {
							status: 400,
							body: {
								code: 'validation',
								message: 'Add the person to the organization first',
								details: {},
								requestId: 'req_7'
							}
						}
					: { status: 201, body: person('u9') }
		});
		const memberForm = () =>
			wrapper.findAll('form').find((f) => f.find('input[type="email"]').exists())!;
		await vi.waitFor(() => expect(wrapper.text()).toContain('Add Member'));
		const email = wrapper.find('input[type="email"]');
		await email.setValue('new@example.test');
		await memberForm().trigger('submit');
		await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
		expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
			email: 'new@example.test',
			role: 'viewer'
		});
		refuse = true;
		await memberForm().find('input[type="email"]').setValue('other@example.test');
		await memberForm().trigger('submit');
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('Add the person to the organization first')
		);
	});
});

import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PoliciesPage from '~/pages/org/policies.vue';
import type { ClassificationEntry, PolicyGroupView } from '~/shared/policies';
import { useDepartmentsStore } from '~/stores/departments';
import { useOrgStore } from '~/stores/org';
import { usePoliciesStore } from '~/stores/policies';
import { useSessionStore } from '~/stores/session';
import {
	calls,
	clearBrowserState,
	failure,
	registerApi,
	type Reply
} from '../stores/store-support';

const ORG = 'org_personal';
const listKey = `GET /api/v1/orgs/${ORG}/policies`;
const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};

const labels: ClassificationEntry[] = (
	['public', 'internal', 'restricted', 'regulated'] as const
).map((label) => ({ label, displayName: null, policyId: null }));

const group = (id: string, over: Partial<PolicyGroupView> = {}): PolicyGroupView => ({
	id,
	name: `Name ${id}`,
	rules: {},
	assignments: [],
	createdAt: '2026-11-01T10:00:00.000Z',
	...over
});

let cleanup: () => void = () => undefined;
let listReply: () => Reply | Promise<Reply>;
const mounted: { unmount: () => void }[] = [];

async function mount(extra: Record<string, Reply | ((call: never) => Reply)> = {}) {
	useOrgStore().$reset();
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': {
			body: {
				items: [{ id: ORG, name: 'Personal', personal: true, role: 'owner' }],
				nextCursor: null
			}
		},
		[listKey]: () => listReply(),
		[`GET /api/v1/orgs/${ORG}/departments`]: { body: { items: [], central: true } },
		[`GET /api/v1/orgs/${ORG}/departments/sites`]: { body: { items: [] } },
		...extra
	} as never);
	await useOrgStore().ensure();
	const wrapper = await mountSuspended(PoliciesPage, { route: '/org/policies' });
	mounted.push(wrapper);
	return wrapper;
}

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useDepartmentsStore().$reset();
	usePoliciesStore().$reset();
	listReply = () => ({ body: { items: [], classifications: labels } });
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	document.body.replaceChildren();
});

describe('policies page', () => {
	it('shows a skeleton, then the empty state and the new group button', async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		listReply = async () => {
			await gate;
			return { body: { items: [], classifications: labels } };
		};
		const wrapper = await mount();
		expect(wrapper.find('[role="status"]').text()).toBe('Loading policies');
		release();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Policy Groups Yet'));
		expect(wrapper.findAll('button').some((b) => b.text() === 'New Policy Group')).toBe(true);
		expect(wrapper.text()).toContain('Data Classification');
	});

	it('lists a group with its rules, and says which rules are saved but not enforced yet', async () => {
		listReply = () => ({
			body: {
				items: [
					group('pol_a', {
						name: 'Regulated sites',
						rules: { maxPreviewHours: 24, dataLocations: ['us'] },
						assignments: [{ kind: 'organization', targetId: ORG }]
					})
				],
				classifications: labels
			}
		});
		const wrapper = await mount();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Regulated sites'));
		const text = wrapper.text();
		expect(text).toContain('Preview Lifetime Cap');
		expect(text).toContain('Data Locations - Saved, not enforced yet');
		expect(text).not.toContain('Preview Lifetime Cap - Saved, not enforced yet');
		expect(text).toContain('The whole organization');
	});

	it('shows an error with a retry that loads the list again', async () => {
		let healthy = false;
		listReply = () =>
			healthy
				? { body: { items: [group('pol_a')], classifications: labels } }
				: failure('internal', 'The service is down', 'req_9');
		const wrapper = await mount();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load Policies'));
		expect(wrapper.text()).toContain('req_9');
		healthy = true;
		await wrapper
			.findAll('button')
			.find((b) => b.text() === 'Try Again')!
			.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Name pol_a'));
	});

	it('says there is no organization when the list answers not found', async () => {
		listReply = () => ({ status: 404, body: failure('not_found', 'Not found', 'req_8').body });
		const wrapper = await mount();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Organization Found'));
	});

	it('creates a group from the editor and sends the rules the form holds', async () => {
		const wrapper = await mount({
			[`POST /api/v1/orgs/${ORG}/policies`]: { status: 201, body: group('pol_new') }
		});
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Policy Groups Yet'));
		await wrapper
			.findAll('button')
			.find((b) => b.text() === 'New Policy Group')!
			.trigger('click');
		expect(wrapper.text()).toContain('Saved, not enforced yet.');
		await wrapper.find('input[maxlength="80"]').setValue('Lockdown');
		await wrapper.find('input[aria-label="Preview Lifetime Cap in Hours"]').setValue('24');
		await wrapper.find('input[aria-label="Blocked Actions"]').setValue('site.delete');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
		expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
			name: 'Lockdown',
			rules: { blockedActions: ['site.delete'], maxPreviewHours: 24 }
		});
	});

	it('refuses a form the rules schema rejects before it sends anything', async () => {
		const wrapper = await mount();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Policy Groups Yet'));
		await wrapper
			.findAll('button')
			.find((b) => b.text() === 'New Policy Group')!
			.trigger('click');
		await wrapper.find('input[maxlength="80"]').setValue('Bad');
		await wrapper.find('input[aria-label="Blocked Actions"]').setValue('site.fly');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() => expect(wrapper.find('[role="alert"]').exists()).toBe(true));
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
	});
});

import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Assignments from '~/components/team/policy/Assignments.vue';
import Classifications from '~/components/team/policy/Classifications.vue';
import Why from '~/components/team/policy/Why.vue';
import type { PolicyGroupView } from '~/shared/policies';
import { usePoliciesStore } from '~/stores/policies';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const ORG = 'org_personal';
const group: PolicyGroupView = {
	id: 'pol_a',
	name: 'Regulated',
	rules: {},
	assignments: [
		{ kind: 'department', targetId: 'd1' },
		{ kind: 'classification', targetId: 'regulated' }
	],
	createdAt: '2026-11-01T10:00:00.000Z'
};

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	clearBrowserState();
	usePoliciesStore().$reset();
	cleanup = registerApi({
		[`GET /api/v1/orgs/${ORG}/policies`]: { body: { items: [group], classifications: [] } },
		[`DELETE /api/v1/orgs/${ORG}/policies/pol_a/assignments/department/d1`]: {
			status: 204,
			body: null
		},
		[`POST /api/v1/orgs/${ORG}/policies/pol_a/assignments`]: { body: group }
	});
});

afterEach(() => {
	mounted.splice(0).forEach((w) => w.unmount());
	cleanup();
	document.body.replaceChildren();
});

describe('policy components', () => {
	it('says which group and rule blocked an action', async () => {
		const w = await mountSuspended(Why, {
			props: { detail: { policyName: 'Regulated', rule: 'forbidden-templates' } }
		});
		mounted.push(w);
		expect(w.text()).toContain('Why Was This Blocked');
		expect(w.text()).toContain('"Regulated" blocks this');
		expect(w.text()).toContain('Forbidden Templates');
	});

	it('lists what a group applies to by name and removes one assignment', async () => {
		const w = await mountSuspended(Assignments, {
			props: {
				orgId: ORG,
				group,
				departments: [{ id: 'd1', name: 'Library' }] as never,
				sites: []
			}
		});
		mounted.push(w);
		expect(w.text()).toContain('Department Library');
		expect(w.text()).toContain('Classification Regulated');
		await w.find('button[aria-label="Remove Department Library"]').trigger('click');
		await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));
		expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
	});

	it('asks for a target before it assigns', async () => {
		const w = await mountSuspended(Assignments, {
			props: { orgId: ORG, group: { ...group, assignments: [] }, departments: [], sites: [] }
		});
		mounted.push(w);
		expect(w.text()).toContain('This group applies nowhere yet.');
		const assign = w.findAll('button').find((b) => b.text() === 'Assign')!;
		await assign.trigger('click');
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
	});

	it('shows the four labels with the group each one picks', async () => {
		const w = await mountSuspended(Classifications, {
			props: {
				orgId: ORG,
				groups: [group],
				entries: [
					{ label: 'public', displayName: null, policyId: null },
					{ label: 'internal', displayName: null, policyId: null },
					{ label: 'restricted', displayName: null, policyId: null },
					{ label: 'regulated', displayName: 'DISC 3', policyId: 'pol_a' }
				]
			}
		});
		mounted.push(w);
		for (const label of ['Public', 'Internal', 'Restricted', 'Regulated']) {
			expect(w.text()).toContain(label);
		}
		const named = w.find('input[aria-label="Your name for Regulated"]');
		expect((named.element as HTMLInputElement).value).toBe('DISC 3');
	});
});

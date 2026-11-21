import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClassificationEntry, PolicyGroupView } from '~/shared/policies';
import { usePoliciesStore } from '~/stores/policies';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

const ORG = 'org_personal';
const PID = 'pol_a';
const listKey = `GET /api/v1/orgs/${ORG}/policies`;

const group = (id: string, over: Partial<PolicyGroupView> = {}): PolicyGroupView => ({
	id,
	name: `Group ${id}`,
	rules: {},
	assignments: [],
	createdAt: '2026-11-01T10:00:00.000Z',
	...over
});

const labels: ClassificationEntry[] = (
	['public', 'internal', 'restricted', 'regulated'] as const
).map((label) => ({ label, displayName: null, policyId: null }));

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	usePoliciesStore().$reset();
});

afterEach(() => {
	cleanup();
});

describe('policies store', () => {
	it('stays not loaded until a list is read', () => {
		expect(usePoliciesStore().policies.get(ORG)).toBeUndefined();
	});

	it('loads once and keeps the groups and labels', async () => {
		cleanup = registerApi({
			[listKey]: { body: { items: [group(PID)], classifications: labels } }
		});
		const store = usePoliciesStore();
		await store.load(ORG);
		await store.load(ORG);
		expect(calls.filter((c) => c.path.endsWith('/policies'))).toHaveLength(1);
		expect(store.policies.get(ORG)).toMatchObject({ status: 'ready' });
		expect(store.policies.get(ORG)?.items.map((g) => g.id)).toEqual([PID]);
		expect(store.policies.get(ORG)?.classifications).toHaveLength(4);
	});

	it('records a missing organization as null and a failure as an error', async () => {
		cleanup = registerApi({
			[listKey]: { status: 404, body: failure('not_found', 'Not found', 'req_1').body }
		});
		const store = usePoliciesStore();
		await store.load(ORG);
		expect(store.policies.get(ORG)).toBeNull();
		cleanup();
		cleanup = registerApi({ [listKey]: failure('internal', 'Something broke', 'req_2') });
		store.$reset();
		await store.load(ORG);
		expect(store.policies.get(ORG)).toMatchObject({ status: 'error' });
		expect(store.policies.get(ORG)?.error?.requestId).toBe('req_2');
	});

	it('sends each change to its path and reads the list again', async () => {
		cleanup = registerApi({
			[listKey]: { body: { items: [group(PID)], classifications: labels } },
			[`POST /api/v1/orgs/${ORG}/policies`]: { status: 201, body: group('pol_b') },
			[`PUT /api/v1/orgs/${ORG}/policies/${PID}`]: { body: group(PID) },
			[`DELETE /api/v1/orgs/${ORG}/policies/${PID}`]: { status: 204, body: null },
			[`POST /api/v1/orgs/${ORG}/policies/${PID}/assignments`]: { body: group(PID) },
			[`DELETE /api/v1/orgs/${ORG}/policies/${PID}/assignments/department/d1`]: {
				status: 204,
				body: null
			},
			[`PUT /api/v1/orgs/${ORG}/policies/classifications/regulated`]: {
				body: { items: [], classifications: labels }
			},
			[`PUT /api/v1/orgs/${ORG}/sites/site_1/classification`]: {
				body: { siteId: 'site_1', classification: 'internal' }
			}
		});
		const store = usePoliciesStore();
		await store.create(ORG, { name: 'B', rules: { maxPreviewHours: 12 } });
		await store.update(ORG, PID, { name: 'A', rules: {} });
		await store.assign(ORG, PID, { kind: 'site', targetId: 'site_1' });
		await store.unassign(ORG, PID, { kind: 'department', targetId: 'd1' });
		await store.nameLabel(ORG, 'regulated', 'DISC 3');
		await store.remove(ORG, PID);
		expect((await store.classifySite(ORG, 'site_1', 'internal')).classification).toBe(
			'internal'
		);
		const sent = calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path, c.body]);
		expect(sent).toEqual([
			['POST', `/api/v1/orgs/${ORG}/policies`, { name: 'B', rules: { maxPreviewHours: 12 } }],
			['PUT', `/api/v1/orgs/${ORG}/policies/${PID}`, { name: 'A', rules: {} }],
			[
				'POST',
				`/api/v1/orgs/${ORG}/policies/${PID}/assignments`,
				{ kind: 'site', targetId: 'site_1' }
			],
			['DELETE', `/api/v1/orgs/${ORG}/policies/${PID}/assignments/department/d1`, undefined],
			[
				'PUT',
				`/api/v1/orgs/${ORG}/policies/classifications/regulated`,
				{ displayName: 'DISC 3' }
			],
			['DELETE', `/api/v1/orgs/${ORG}/policies/${PID}`, undefined],
			[
				'PUT',
				`/api/v1/orgs/${ORG}/sites/site_1/classification`,
				{ classification: 'internal' }
			]
		]);
	});
});

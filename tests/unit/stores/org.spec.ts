import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useOrgStore, type OrgSummary } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { useSitesStore } from '~/stores/sites';
import { calls, clearBrowserState, cookieValue, failure, registerApi } from './store-support';

const personal: OrgSummary = {
	id: 'org_personal',
	name: 'Personal',
	personal: true,
	role: 'owner'
};
const agency: OrgSummary = { id: 'org_agency', name: 'Agency', personal: false, role: 'admin' };

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useOrgStore().$reset();
	useSitesStore().$reset();
});

afterEach(() => {
	cleanup();
});

describe('org store', () => {
	it('reads every page and selects the first organization when nothing is stored', async () => {
		cleanup = registerApi({
			'GET /api/v1/me/organizations': ({ query }) =>
				query.cursor === 'page2'
					? { body: { items: [agency], nextCursor: null } }
					: { body: { items: [personal], nextCursor: 'page2' } }
		});
		const org = useOrgStore();

		await org.ensure();

		expect(org.items).toEqual([personal, agency]);
		expect(org.current?.id).toBe('org_personal');
		expect(cookieValue('drupflare_org')).toBe('org_personal');
	});

	it('keeps a stored organization that is still in the list', async () => {
		document.cookie = 'drupflare_org=org_agency; path=/';
		cleanup = registerApi({
			'GET /api/v1/me/organizations': {
				body: { items: [personal, agency], nextCursor: null }
			}
		});
		const org = useOrgStore();

		await org.ensure();

		expect(org.current?.id).toBe('org_agency');
	});

	it('drops a stored organization that is no longer in the list', async () => {
		document.cookie = 'drupflare_org=org_removed; path=/';
		cleanup = registerApi({
			'GET /api/v1/me/organizations': { body: { items: [personal], nextCursor: null } }
		});
		const org = useOrgStore();

		await org.ensure();

		expect(org.current?.id).toBe('org_personal');
		expect(cookieValue('drupflare_org')).toBe('org_personal');
	});

	it('ignores a select for an organization outside the list', async () => {
		cleanup = registerApi({
			'GET /api/v1/me/organizations': {
				body: { items: [personal, agency], nextCursor: null }
			}
		});
		const org = useOrgStore();
		await org.ensure();

		org.select('org_other');
		expect(org.current?.id).toBe('org_personal');

		org.select('org_agency');
		expect(org.current?.id).toBe('org_agency');
		expect(cookieValue('drupflare_org')).toBe('org_agency');
	});

	it('reads the plan of an organization once and keeps it per organization', async () => {
		const plan = { planId: 'managed-free', features: { customCode: false } };
		cleanup = registerApi({
			'GET /api/v1/me/organizations': { body: { items: [personal], nextCursor: null } },
			'GET /api/v1/orgs/org_personal/entitlement': { body: plan }
		});
		const org = useOrgStore();
		await org.ensure();
		expect(org.currentPlan).toBeUndefined();

		await org.loadPlan('org_personal');
		await org.loadPlan('org_personal');

		expect(org.currentPlan).toEqual(plan);
		expect(calls.filter((call) => call.path.endsWith('/entitlement'))).toHaveLength(1);
		org.reset();
		expect(org.currentPlan).toBeUndefined();
	});

	it('leaves the plan unloaded when the read fails', async () => {
		cleanup = registerApi({
			'GET /api/v1/orgs/org_personal/entitlement': failure('internal', 'failed', 'req_plan')
		});
		const org = useOrgStore();

		await org.loadPlan('org_personal');

		expect(org.plans.has('org_personal')).toBe(false);
	});

	it('records a failed load and keeps the list unknown', async () => {
		cleanup = registerApi({
			'GET /api/v1/me/organizations': failure('internal', 'failed', 'req_org')
		});
		const org = useOrgStore();

		await org.ensure();

		expect(org.items).toBeUndefined();
		expect(org.error?.requestId).toBe('req_org');
	});

	it('sends one request when two callers ask at once', async () => {
		cleanup = registerApi({
			'GET /api/v1/me/organizations': { body: { items: [personal], nextCursor: null } }
		});
		const org = useOrgStore();

		await Promise.all([org.ensure(), org.ensure(), org.load()]);

		expect(calls.filter((call) => call.path === '/api/v1/me/organizations')).toHaveLength(1);
		expect(org.items).toEqual([personal]);
	});

	it('leaves no error behind when a 401 signs the visitor out', async () => {
		cleanup = registerApi({
			'GET /api/v1/me/organizations': {
				status: 401,
				body: {
					code: 'unauthenticated',
					message: 'Sign in',
					details: {},
					requestId: 'req_401'
				}
			}
		});
		const org = useOrgStore();
		const session = useSessionStore();

		await org.ensure();

		expect(session.me).toBeNull();
		expect(org.items).toBeUndefined();
		expect(org.error).toBeNull();
	});
});

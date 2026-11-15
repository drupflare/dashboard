import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAccessStore } from '~/stores/access';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

const base = '/api/v1/orgs/org_a/sites/site_1';
const accessPath = `GET ${base}/access`;
const rulesPath = `POST ${base}/access/rules`;
const removePath = `DELETE ${base}/access/rules/rule_1`;

const rule = {
	id: 'rule_1',
	environment: 'prod',
	preset: 'email-invite',
	values: ['ada@example.test'],
	expiresAt: null,
	createdBy: 'user:usr_1',
	createdAt: 1
};

const view = {
	rules: [rule],
	presets: [{ id: 'members', label: 'Members', available: true, unlockedBy: null }],
	inviteeLimit: 5
};

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useAccessStore().$reset();
});

afterEach(() => {
	cleanup();
});

describe('access store', () => {
	it('loads the access view and keeps it under the site', async () => {
		cleanup = registerApi({ [accessPath]: { body: view } });
		const access = useAccessStore();

		const loaded = await access.read('org_a', 'site_1');

		expect(loaded).toEqual(view);
		expect(access.views.get('site_1')).toEqual(view);
		expect(access.errors.has('site_1')).toBe(false);
	});

	it('records a known absence as null when the site is not there', async () => {
		cleanup = registerApi({
			[accessPath]: { status: 404, body: { code: 'not_found', message: 'Not found' } }
		});
		const access = useAccessStore();

		expect(await access.read('org_a', 'site_1')).toBeNull();
		expect(access.views.get('site_1')).toBeNull();
	});

	it('keeps a failed read as an error and rethrows it', async () => {
		cleanup = registerApi({ [accessPath]: failure('internal', 'boom', 'req_1') });
		const access = useAccessStore();

		await expect(access.read('org_a', 'site_1')).rejects.toBeTruthy();
		expect(access.errors.get('site_1')?.status).toBe(500);
		expect(access.views.has('site_1')).toBe(false);
	});

	it('posts a rule, returns the one-time token and refreshes the view', async () => {
		cleanup = registerApi({
			[rulesPath]: { status: 201, body: { rule, linkToken: 'tok_once' } },
			[accessPath]: { body: view }
		});
		const access = useAccessStore();

		const result = await access.addRule('org_a', 'site_1', {
			environment: 'prod',
			preset: 'review-link',
			expiresInHours: 24
		});

		expect(result).toEqual({ active: true, rule, linkToken: 'tok_once' });
		expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
			environment: 'prod',
			preset: 'review-link',
			expiresInHours: 24
		});
		expect(access.views.get('site_1')).toEqual(view);
	});

	it('reports a saved rule as not active when the site has not picked it up', async () => {
		cleanup = registerApi({
			[rulesPath]: {
				status: 501,
				body: { code: 'not_built', message: 'not yet', details: {}, requestId: 'r' }
			},
			[accessPath]: { body: view }
		});
		const access = useAccessStore();

		const result = await access.addRule('org_a', 'site_1', {
			environment: 'prod',
			preset: 'members'
		});

		expect(result).toEqual({ active: false });
		expect(access.views.get('site_1')).toEqual(view);
	});

	it('rethrows a plan refusal with the server message', async () => {
		cleanup = registerApi({
			[rulesPath]: {
				status: 403,
				body: {
					code: 'forbidden',
					message: 'This access type needs the Site plan',
					details: { unlockedBy: 'managed-site' },
					requestId: 'r'
				}
			}
		});
		const access = useAccessStore();

		await expect(
			access.addRule('org_a', 'site_1', {
				environment: 'prod',
				preset: 'github-user',
				values: ['a']
			})
		).rejects.toMatchObject({
			code: 'forbidden',
			message: 'This access type needs the Site plan'
		});
	});

	it('reports a saved rule as not active when the change could not be started', async () => {
		cleanup = registerApi({
			[rulesPath]: {
				status: 409,
				body: {
					code: 'conflict',
					message: 'saved',
					details: { saved: true },
					requestId: 'r'
				}
			},
			[accessPath]: { body: view }
		});

		const result = await useAccessStore().addRule('org_a', 'site_1', {
			environment: 'prod',
			preset: 'members'
		});

		expect(result).toEqual({ active: false });
	});

	it('rethrows a conflict that is not a saved change', async () => {
		cleanup = registerApi({
			[rulesPath]: {
				status: 409,
				body: {
					code: 'conflict',
					message: 'too many',
					details: { limit: 5 },
					requestId: 'r'
				}
			}
		});

		await expect(
			useAccessStore().addRule('org_a', 'site_1', { environment: 'prod', preset: 'members' })
		).rejects.toMatchObject({ code: 'conflict' });
	});

	it('reports a removed rule as not active when the site has not picked it up', async () => {
		cleanup = registerApi({
			[removePath]: {
				status: 501,
				body: { code: 'not_built', message: 'not yet', details: {}, requestId: 'r' }
			},
			[accessPath]: { body: { ...view, rules: [] } }
		});
		const access = useAccessStore();

		expect(await access.removeRule('org_a', 'site_1', 'rule_1')).toEqual({ active: false });
		expect(access.views.get('site_1')?.rules).toEqual([]);
	});

	it('lists the environments of a site', async () => {
		cleanup = registerApi({
			[`GET ${base}/environments`]: {
				body: {
					items: [
						{
							id: 'env_stage',
							kind: 'staging',
							name: 'Staging',
							host: 'h',
							status: 'ready',
							sourceBackupId: null,
							ttlAt: null,
							createdAt: 1
						}
					]
				}
			}
		});
		const access = useAccessStore();

		const items = await access.loadEnvironments('org_a', 'site_1');

		expect(items.map((item) => item.name)).toEqual(['Staging']);
		expect(access.environments.get('site_1')?.length).toBe(1);
	});
});

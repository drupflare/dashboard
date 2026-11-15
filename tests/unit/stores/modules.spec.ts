import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changeKey, hasEnded, poll, useModulesStore } from '~/stores/modules';
import { useOperationsStore } from '~/stores/operations';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

const listPath = 'GET /api/v1/orgs/org_a/sites/site_1/modules';
const checkPath = 'POST /api/v1/orgs/org_a/sites/site_1/modules/check';

const item = (name: string) => ({
	name,
	label: name,
	kind: 'unknown',
	state: 'verified',
	shipping: false,
	needs: [],
	installed: null
});

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useModulesStore().$reset();
});

afterEach(() => {
	cleanup();
});

describe('modules store', () => {
	it('loads a list with its query and keeps it under that query', async () => {
		cleanup = registerApi({
			[listPath]: { body: { items: [item('drupal/token')] } }
		});
		const modules = useModulesStore();

		const rows = await modules.search('org_a', 'site_1', { q: 'tok', state: 'verified' });

		expect(rows?.map((row) => row.name)).toEqual(['drupal/token']);
		expect(calls[0]?.query).toEqual({ q: 'tok', state: 'verified' });
		expect(modules.lists.get('site_1|tok|verified|')).toEqual(rows);
	});

	it('records a known absence as null when the site is not there', async () => {
		cleanup = registerApi({
			[listPath]: { status: 404, body: { code: 'not_found', message: 'Not found' } }
		});
		const modules = useModulesStore();

		expect(await modules.search('org_a', 'site_1', {})).toBeNull();
		expect(modules.lists.get('site_1|||')).toBeNull();
	});

	it('keeps a failed search as an error and rethrows it', async () => {
		cleanup = registerApi({
			[listPath]: failure('internal', 'boom', 'req_1')
		});
		const modules = useModulesStore();

		await expect(modules.search('org_a', 'site_1', {})).rejects.toBeTruthy();
		expect(modules.errors.get('site_1|||')?.status).toBe(500);
		expect(modules.lists.has('site_1|||')).toBe(false);
	});

	it('posts the module name to the check route and keeps the last verdict', async () => {
		cleanup = registerApi({
			[checkPath]: {
				body: {
					ok: true,
					conflicts: [],
					message: 'No conflicts. The site can take this module.'
				}
			}
		});
		const modules = useModulesStore();

		const verdict = await modules.check('org_a', 'site_1', 'drupal/token');

		expect(verdict.ok).toBe(true);
		expect(calls[0]?.body).toEqual({ name: 'drupal/token' });
		expect(modules.checks.get('site_1|drupal/token')).toEqual(verdict);
	});

	describe('changes', () => {
		const installPath = 'POST /api/v1/orgs/org_a/sites/site_1/modules/install';
		const opPath = 'GET /api/v1/orgs/org_a/operations/op_aaaaaaaa';
		const op = (status: string) => ({
			id: 'op_aaaaaaaa',
			type: 'module.install',
			status,
			steps: [],
			targetIds: ['site_1']
		});

		beforeEach(() => {
			useOperationsStore().reset();
			poll.ms = 0;
		});

		it('starts a change with an Idempotency-Key and keeps the operation', async () => {
			cleanup = registerApi({ [installPath]: { status: 202, body: op('planned') } });
			const modules = useModulesStore();

			const started = await modules.change('org_a', 'site_1', 'install', {
				name: 'drupal/token',
				confirm: true
			});

			expect(started.id).toBe('op_aaaaaaaa');
			expect(calls[0]?.body).toEqual({ name: 'drupal/token', confirm: true });
			expect(calls[0]?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
			expect(modules.changes.get(changeKey('site_1', 'drupal/token', 'install'))).toEqual(
				started
			);
		});

		it('rethrows a refusal and keeps nothing', async () => {
			cleanup = registerApi({
				[installPath]: {
					status: 422,
					body: { code: 'unprocessable', message: 'This module is already included.' }
				}
			});
			const modules = useModulesStore();

			await expect(
				modules.change('org_a', 'site_1', 'install', { name: 'drupal/token' })
			).rejects.toMatchObject({ status: 422, message: 'This module is already included.' });
			expect(modules.changes.size).toBe(0);
		});

		it('reads the operation until it ends and keeps each answer', async () => {
			let reads = 0;
			cleanup = registerApi({
				[opPath]: () => ({ body: op(++reads < 3 ? 'running' : 'succeeded') })
			});
			const modules = useModulesStore();

			const done = await modules.follow(
				'org_a',
				'site_1',
				'install',
				op('planned') as never,
				'drupal/token'
			);

			expect(done.status).toBe('succeeded');
			expect(reads).toBe(3);
			expect(
				modules.changes.get(changeKey('site_1', 'drupal/token', 'install'))?.status
			).toBe('succeeded');
		});

		it('stops reading when the operation is gone', async () => {
			cleanup = registerApi({
				[opPath]: { status: 404, body: { code: 'not_found', message: 'Not found' } }
			});
			const done = await useModulesStore().follow(
				'org_a',
				'site_1',
				'install',
				op('running') as never,
				'drupal/token'
			);
			expect(done.status).toBe('running');
		});

		it('does not read an operation that already ended', async () => {
			cleanup = registerApi({});
			const done = await useModulesStore().follow(
				'org_a',
				'site_1',
				'install',
				op('failed') as never,
				'drupal/token'
			);
			expect(done.status).toBe('failed');
			expect(calls).toEqual([]);
		});

		it('names the statuses that end an operation', () => {
			for (const status of ['succeeded', 'failed', 'cancelled', 'rolled-back']) {
				expect(hasEnded({ status } as never)).toBe(true);
			}
			for (const status of ['planned', 'running', 'verifying']) {
				expect(hasEnded({ status } as never)).toBe(false);
			}
		});
	});
});

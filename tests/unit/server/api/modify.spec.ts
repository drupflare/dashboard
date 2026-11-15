import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	newOperation as engineOperation,
	freezePlan
} from '../../../../engine/src/operations/state';
import { planModifyApply } from '../../../../engine/src/workflows/modify-apply';
import modifyRoute from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/modify.post';
import rollbackRoute from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/modify/rollback.post';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { ApiError } from '../../../../src/shared/errors';
import { ORG, OTHER_ORG } from '../../domain/fixtures';
import { asUser, send, setup, SITES } from '../fixtures/harness';

const SITE_ID = 'site_modifyrt01';
const OTHER_SITE = 'site_modifyrt02';
SITES[SITE_ID] = ORG;
SITES[OTHER_SITE] = OTHER_ORG;

const mocks = vi.hoisted(() => ({
	modify: vi.fn(),
	rollback: vi.fn()
}));

vi.mock('../../../../src/server/services/modify', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../src/server/services/modify')>()),
	modifySiteFiles: mocks.modify,
	rollbackSiteEdit: mocks.rollback
}));

const ROUTE = '/api/v1/orgs/:orgId/sites/:id/modify';
const BASE = `/api/v1/orgs/${ORG}/sites/${SITE_ID}/modify`;
const NOW = 1_790_000_000_000;

async function operationFor() {
	const plan = planModifyApply({
		siteId: SITE_ID,
		backupId: `bkp_${'e'.repeat(26)}`,
		name: 'my_module'
	});
	return {
		operation: engineOperation({
			id: 'op_routetest01',
			orgId: ORG,
			idempotencyKey: 'key-0001',
			frozen: await freezePlan(plan),
			now: NOW
		}),
		version: 0
	};
}

const body = {
	files: [{ path: 'modules/custom/my_module/my_module.module', content: '<?php' }],
	note: 'Fix the header'
};
const post = (path: string, route: string, json: unknown, key: string | null = 'key-0001') =>
	send(path.endsWith('/rollback') ? rollbackRoute : modifyRoute, route, {
		method: 'POST',
		path,
		headers: key === null ? asUser : { ...asUser, 'idempotency-key': key },
		json
	});

afterEach(() => {
	resetApiDeps();
	vi.clearAllMocks();
});

describe('POST modify', () => {
	it('hands the files, note and key to the service and answers 202 with the operation', async () => {
		setup();
		mocks.modify.mockResolvedValue(await operationFor());
		const res = await post(BASE, ROUTE, body);
		expect(res.status).toBe(202);
		expect(res.json).toMatchObject({ id: 'op_routetest01', type: 'modify.apply' });
		expect(mocks.modify).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				orgId: ORG,
				siteId: SITE_ID,
				files: body.files,
				note: 'Fix the header',
				idempotencyKey: 'key-0001'
			})
		);
	});

	it('refuses a request without an Idempotency-Key and never calls the service', async () => {
		setup();
		const res = await post(BASE, ROUTE, body, null);
		expect(res.status).toBe(400);
		expect(mocks.modify).not.toHaveBeenCalled();
	});

	it.each([
		['an empty file list', { files: [], note: 'x' }],
		['a missing note', { files: body.files }],
		['a blank note', { files: body.files, note: '   ' }],
		['an unknown field', { ...body, extra: true }]
	])('refuses %s with 400', async (_label, json) => {
		setup();
		expect((await post(BASE, ROUTE, json)).status).toBe(400);
		expect(mocks.modify).not.toHaveBeenCalled();
	});

	it('passes the service refusal through as 422 with its reason', async () => {
		setup();
		mocks.modify.mockRejectedValue(
			new ApiError('unprocessable', 'Edits are for Drupal sites.', { reason: 'not_drupal' })
		);
		const res = await post(BASE, ROUTE, body);
		expect(res.status).toBe(422);
		expect(res.json).toMatchObject({ details: { reason: 'not_drupal' } });
	});

	it('refuses a site of another organisation at the authorisation gate', async () => {
		setup();
		const res = await post(`/api/v1/orgs/${ORG}/sites/${OTHER_SITE}/modify`, ROUTE, body);
		expect(res.status).toBe(403);
		expect(mocks.modify).not.toHaveBeenCalled();
	});
});

describe('POST modify/rollback', () => {
	const PATH = `${BASE}/rollback`;
	const RB_ROUTE = `${ROUTE}/rollback`;

	it('hands the revision id to the service and answers 202', async () => {
		setup();
		mocks.rollback.mockResolvedValue(await operationFor());
		const res = await post(PATH, RB_ROUTE, { revision: 'rev_op_a' });
		expect(res.status).toBe(202);
		expect(mocks.rollback).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				siteId: SITE_ID,
				revisionId: 'rev_op_a',
				idempotencyKey: 'key-0001'
			})
		);
	});

	it('refuses a missing key, a body without a revision and an unknown field', async () => {
		setup();
		expect((await post(PATH, RB_ROUTE, { revision: 'rev_op_a' }, null)).status).toBe(400);
		expect((await post(PATH, RB_ROUTE, {})).status).toBe(400);
		expect((await post(PATH, RB_ROUTE, { revision: 'a', extra: 1 })).status).toBe(400);
		expect(mocks.rollback).not.toHaveBeenCalled();
	});
});

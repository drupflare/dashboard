import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import adminLadder from '../../../../src/server/api/v1/admin/ladder/index.get';
import adminLadderSwitch from '../../../../src/server/api/v1/admin/ladder/switch.put';
import repairUndo from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/repairs/[repairId]/undo.post';
import { setLadderServices } from '../../../../src/server/services/ladder';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { ORG } from '../../domain/fixtures';
import { SITES, asUser, send, setup } from '../fixtures/harness';

const SITE = `site_${'a'.repeat(20)}`;
const BASE = `/api/v1/orgs/${ORG}/sites/${SITE}/repairs`;
const ROUTE = '/api/v1/orgs/:orgId/sites/:id/repairs';
const idem = { 'idempotency-key': 'key-repairs-1' };

beforeEach(() => {
	SITES[SITE] = ORG;
});

afterEach(() => {
	delete SITES[SITE];
	setLadderServices(null);
	resetApiDeps();
});

describe('who may undo a repair', () => {
	it('refuses a viewer on the undo before any store is touched', async () => {
		setup({ role: 'viewer' });
		const reply = await send(repairUndo, `${ROUTE}/:repairId/undo`, {
			method: 'POST',
			path: `${BASE}/rpr_1/undo`,
			headers: { ...asUser, ...idem }
		});
		expect(reply.status).toBe(403);
	});

	it('refuses the undo of a site in another organization before the handler runs', async () => {
		setup({ role: 'owner' });
		SITES[SITE] = 'org_other';
		const reply = await send(repairUndo, `${ROUTE}/:repairId/undo`, {
			method: 'POST',
			path: `${BASE}/rpr_1/undo`,
			headers: { ...asUser, ...idem }
		});
		expect(reply.status).toBe(403);
	});
});

describe('the admin ladder', () => {
	it('refuses a signed-in owner who is not a platform admin', async () => {
		setup({ role: 'owner' });
		const read = await send(adminLadder, '/api/v1/admin/ladder', {
			path: '/api/v1/admin/ladder',
			headers: asUser
		});
		const write = await send(adminLadderSwitch, '/api/v1/admin/ladder/switch', {
			method: 'PUT',
			path: '/api/v1/admin/ladder/switch',
			headers: asUser,
			json: { scope: 'global', scopeId: '', auto: false, confirmation: 'global' }
		});
		expect([read.status, write.status]).toEqual([403, 403]);
	});
});

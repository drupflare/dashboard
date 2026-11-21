import type { EventHandler } from 'h3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pilotReportRoute from '../../../../src/server/api/v1/orgs/[orgId]/pilots/[id]/report.get';
import pilotsList from '../../../../src/server/api/v1/orgs/[orgId]/pilots/index.get';
import pilotCreate from '../../../../src/server/api/v1/orgs/[orgId]/pilots/index.post';
import { setPilotServices } from '../../../../src/server/services/pilots';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { facts, fresh, member, ORG, OTHER_ORG } from '../../domain/fixtures';
import { asUser, send as sendRequest, setup } from '../fixtures/harness';

const send = (
	handler: EventHandler,
	route: string,
	req: Parameters<typeof sendRequest>[2] = { path: route }
) => sendRequest(handler, route, req);

// the services answer nothing; a refusal must come before any read reaches them
const refusingDb = {
	getDb: async () => {
		throw new Error('the database must not be reached');
	},
	usage: { intervals: async () => new Map() },
	newId: () => 'x',
	now: () => 0
};

beforeEach(() => {
	setup();
	setPilotServices(refusingDb);
});

afterEach(() => {
	setPilotServices(null);
	resetApiDeps();
});

describe('pilot routes', () => {
	it('refuse a member of another organisation before the services run', async () => {
		setup({ role: 'owner' });
		const reply = await send(pilotsList, `/api/v1/orgs/:orgId/pilots`, {
			path: `/api/v1/orgs/${OTHER_ORG}/pilots`,
			headers: asUser
		});
		expect([403, 404]).toContain(reply.status);
		expect(reply.text).not.toContain('database must not be reached');
	});

	it('refuse an organisation whose plan does not include pilots', async () => {
		setup({
			role: 'owner',
			facts: () => facts({ ...member('owner'), ...fresh, entitlements: [] })
		});
		const reply = await send(pilotsList, `/api/v1/orgs/:orgId/pilots`, {
			path: `/api/v1/orgs/${ORG}/pilots`,
			headers: asUser
		});
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({ code: 'forbidden' });
	});

	it('refuse a viewer who cannot create a pilot', async () => {
		setup({ role: 'viewer' });
		const reply = await send(pilotCreate, `/api/v1/orgs/:orgId/pilots`, {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/pilots`,
			headers: asUser,
			json: { name: 'Pilot', startDate: '2026-02-01' }
		});
		expect(reply.status).toBe(403);
	});

	it('answer 404 for a report of a pilot in another organisation', async () => {
		const reply = await send(pilotReportRoute, `/api/v1/orgs/:orgId/pilots/:id/report`, {
			path: `/api/v1/orgs/${OTHER_ORG}/pilots/pil_1/report`,
			headers: asUser
		});
		expect(reply.status).toBeGreaterThanOrEqual(400);
	});
});

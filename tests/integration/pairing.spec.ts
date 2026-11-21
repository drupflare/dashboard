import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSigningKey } from '../../contracts/src/common';
import { ensureCollegeDB } from '../../src/server/db/collegedb';
import { withAtomicBatch } from '../../src/server/db/repos/atomic-shards';
import {
	claimNode,
	fleetServices,
	resetFleetServices,
	setFleetServices,
	startPairing,
	type FleetServices
} from '../../src/server/services/fleet';
import { ApiError } from '../../src/shared/errors';
import { openBindings, type Bindings, type OpenBindings } from '../bindings/support';
import { FakeNode } from '../rigs/fake-node';

let harness: OpenBindings;
let env: Bindings;
let services: FleetServices;

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
	const dashboard = await generateSigningKey();
	setFleetServices({
		getDb: () => ensureCollegeDB(withAtomicBatch(env)),
		audit: async () => undefined,
		baseUrl: 'https://app.drupflare.test',
		linkOrigin: 'wss://link.drupflare.test',
		dashboardPublicKey: dashboard.publicKey,
		now: () => Date.now()
	});
	services = fleetServices();
});

afterAll(async () => {
	resetFleetServices();
	await harness.close();
});

describe('pairing a node in process', () => {
	it('claims a fresh pairing code once and hands the box the link and the dashboard key', async () => {
		const pairing = await startPairing(services, { orgId: 'org-integration', actor: 'usr_it' });
		const box = await FakeNode.create({ now: () => Date.now() });

		const response = await claimNode(services, box.claimBody(pairing.claimToken));
		box.adopt(response);

		expect(box.nodeId).toMatch(/^nod_/);
		expect(box.dashboardPublicKey).toBe(response.dashboardPublicKey);
		expect(response.linkUrl).toBe(`wss://link.drupflare.test/link/${box.nodeId}`);
	});

	it('refuses a second claim of the same code', async () => {
		const pairing = await startPairing(services, { orgId: 'org-integration', actor: 'usr_it' });
		const first = await FakeNode.create({ now: () => Date.now() });
		await claimNode(services, first.claimBody(pairing.claimToken));

		const second = await FakeNode.create({ now: () => Date.now() });
		const refused = await claimNode(services, second.claimBody(pairing.claimToken)).then(
			() => null,
			(error: unknown) => error
		);

		expect(refused).toBeInstanceOf(ApiError);
		expect((refused as ApiError).details).toEqual({ reason: 'already_claimed' });
	});
});

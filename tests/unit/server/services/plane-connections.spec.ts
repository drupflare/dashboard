import { describe, expect, it } from 'vitest';
import {
	connectCloudflare,
	listPlaneConnections,
	revokeConnection,
	validateConnection
} from '../../../../src/server/services/plane-connections';
import { decryptRecordText } from '../../../../src/shared/custody/envelope';
import { planeConnectionAad } from '../../../../src/shared/custody/records';
import { ApiError } from '../../../../src/shared/errors';
import { sqliteClient } from '../fixtures/sqlite-client';
import {
	ACCOUNT,
	GIVEN,
	NARROW,
	ORG,
	OTHER,
	SECOND,
	addSelfManagedSite,
	world
} from './plane-connections-support';

type Raw = ReturnType<typeof sqliteClient>['raw'];

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(ApiError);
		return error as ApiError;
	}
	throw new Error('expected an ApiError');
}

const reasonOf = (error: ApiError) => (error.details as { reason?: string } | undefined)?.reason;

const rowOf = (raw: Raw) =>
	raw.prepare('SELECT * FROM plane_connections').get() as Record<string, unknown> | undefined;

describe('connectCloudflare', () => {
	it('makes a narrower token, keeps only that one sealed and reports the account', async () => {
		const { raw, deps, cf, ring, audits } = await world();
		const result = await connectCloudflare(deps, { orgId: ORG, token: GIVEN });
		expect(result.connection).toMatchObject({
			accountId: ACCOUNT,
			accountName: 'Campus Site',
			state: 'active',
			narrowerToken: true,
			workersSubdomain: 'acme'
		});
		const row = rowOf(raw)!;
		const opened = await decryptRecordText(
			JSON.parse(row.credential_envelope as string),
			planeConnectionAad(row.id as string),
			ring
		);
		expect(opened).toBe(NARROW);
		expect(row.minted).toBe(1);
		expect(row.token_id).toBe('tok_narrow');
		const mint = cf.calls.find((call) => call.method === 'POST')!;
		expect(mint.token).toBe(GIVEN);
		expect(mint.body).not.toContain('token-management');
		expect(cf.calls.find((call) => call.path.endsWith('/workers/subdomain'))!.token).toBe(
			NARROW
		);
		expect(audits).toEqual([[ORG, 'plane.connection.create', row.id as string]]);
	});

	it('keeps the given token when it cannot make a narrower one, and says so', async () => {
		const { raw, deps, ring } = await world({ groupsReadable: false });
		const result = await connectCloudflare(deps, { orgId: ORG, token: GIVEN });
		expect(result.connection.narrowerToken).toBe(false);
		expect(result.message).toContain('could not make a narrower one');
		const row = rowOf(raw)!;
		expect(row.minted).toBe(0);
		expect(
			await decryptRecordText(
				JSON.parse(row.credential_envelope as string),
				planeConnectionAad(row.id as string),
				ring
			)
		).toBe(GIVEN);
	});

	it('stores nothing and deletes the new token when the narrower one cannot edit scripts', async () => {
		const { raw, deps, cf } = await world({ narrowBroken: true });
		const error = await refusal(connectCloudflare(deps, { orgId: ORG, token: GIVEN }));
		expect(reasonOf(error)).toBe('downscope_failed');
		expect(rowOf(raw)).toBeUndefined();
		expect(
			cf.calls.some((call) => call.method === 'DELETE' && call.path.endsWith('tok_narrow'))
		).toBe(true);
	});

	it('stores nothing when Cloudflare refuses to make the token', async () => {
		const { raw, deps } = await world({ mintStatus: 500 });
		expect(reasonOf(await refusal(connectCloudflare(deps, { orgId: ORG, token: GIVEN })))).toBe(
			'downscope_failed'
		);
		expect(rowOf(raw)).toBeUndefined();
	});

	it('refuses a token that cannot edit scripts', async () => {
		const { raw, deps } = await world({ denied: new Set(['workers/scripts']) });
		expect(reasonOf(await refusal(connectCloudflare(deps, { orgId: ORG, token: GIVEN })))).toBe(
			'scripts_missing'
		);
		expect(rowOf(raw)).toBeUndefined();
	});

	it('refuses an expired token', async () => {
		const { deps } = await world({ verify: 'expired' });
		expect(reasonOf(await refusal(connectCloudflare(deps, { orgId: ORG, token: GIVEN })))).toBe(
			'token_expired'
		);
	});

	it('asks which account when the token sees more than one', async () => {
		const accounts = [
			{ id: ACCOUNT, name: 'One' },
			{ id: SECOND, name: 'Two' }
		];
		const { deps } = await world({ accounts, groupsReadable: false });
		expect(reasonOf(await refusal(connectCloudflare(deps, { orgId: ORG, token: GIVEN })))).toBe(
			'choose_account'
		);
		const chosen = await connectCloudflare(deps, {
			orgId: ORG,
			token: GIVEN,
			accountId: SECOND
		});
		expect(chosen.connection.accountId).toBe(SECOND);
	});

	it('refuses an account that is already connected for the organisation', async () => {
		const { deps } = await world({ groupsReadable: false });
		await connectCloudflare(deps, { orgId: ORG, token: GIVEN });
		expect(reasonOf(await refusal(connectCloudflare(deps, { orgId: ORG, token: GIVEN })))).toBe(
			'already_connected'
		);
	});

	it('lets another organisation connect the same account', async () => {
		const { deps } = await world({ groupsReadable: false });
		await connectCloudflare(deps, { orgId: ORG, token: GIVEN });
		const other = await connectCloudflare(deps, { orgId: OTHER, token: GIVEN });
		expect(other.connection.state).toBe('active');
	});

	it('takes a new token in place when the connection went invalid', async () => {
		const { raw, deps, cf } = await world({ groupsReadable: false });
		const first = await connectCloudflare(deps, { orgId: ORG, token: GIVEN });
		cf.state.denied.add('workers/scripts');
		const checked = await validateConnection(deps, ORG, first.connection.id);
		expect(checked.state).toBe('invalid');
		cf.state.denied.clear();
		const again = await connectCloudflare(deps, {
			orgId: ORG,
			token: 'fresh-token-value-0123456789'
		});
		expect(again.connection.id).toBe(first.connection.id);
		expect(again.connection.state).toBe('active');
		expect(raw.prepare('SELECT COUNT(*) AS n FROM plane_connections').get()).toEqual({ n: 1 });
	});

	it('records no subdomain when the account has none', async () => {
		const { deps } = await world({ groupsReadable: false, subdomain: null });
		const result = await connectCloudflare(deps, { orgId: ORG, token: GIVEN });
		expect(result.connection.workersSubdomain).toBeNull();
	});
});

describe('validateConnection', () => {
	it('records a fresh reading and the time', async () => {
		const { deps } = await world({ groupsReadable: false });
		const { connection } = await connectCloudflare(deps, { orgId: ORG, token: GIVEN });
		const checked = await validateConnection(deps, ORG, connection.id);
		expect(checked.state).toBe('active');
		expect(checked.lastValidatedAt).toBeGreaterThan(connection.lastValidatedAt);
	});

	it('marks the connection invalid when scripts access is gone', async () => {
		const { deps, cf } = await world({ groupsReadable: false });
		const { connection } = await connectCloudflare(deps, { orgId: ORG, token: GIVEN });
		cf.state.denied.add('workers/scripts');
		expect((await validateConnection(deps, ORG, connection.id)).state).toBe('invalid');
		expect((await listPlaneConnections(deps, ORG))[0]!.state).toBe('invalid');
	});

	it('changes nothing when Cloudflare gives no answer', async () => {
		const { raw, deps, cf } = await world({ groupsReadable: false });
		const { connection } = await connectCloudflare(deps, { orgId: ORG, token: GIVEN });
		const before = rowOf(raw);
		cf.state.verify = 'throw';
		expect(reasonOf(await refusal(validateConnection(deps, ORG, connection.id)))).toBe(
			'unreachable'
		);
		expect(rowOf(raw)).toEqual(before);
	});

	it('answers not found for another organisation and conflict for a revoked connection', async () => {
		const { deps } = await world({ groupsReadable: false });
		const { connection } = await connectCloudflare(deps, { orgId: ORG, token: GIVEN });
		expect((await refusal(validateConnection(deps, OTHER, connection.id))).code).toBe(
			'not_found'
		);
		await revokeConnection(deps, ORG, connection.id, []);
		expect(reasonOf(await refusal(validateConnection(deps, ORG, connection.id)))).toBe(
			'revoked'
		);
	});
});

describe('revokeConnection', () => {
	it('deletes the token it made, wipes the stored one and audits', async () => {
		const { raw, deps, cf, audits } = await world();
		const { connection } = await connectCloudflare(deps, { orgId: ORG, token: GIVEN });
		const result = await revokeConnection(deps, ORG, connection.id, []);
		expect(result.tokenRemoval).toBe('deleted');
		expect(result.connection.state).toBe('revoked');
		expect(rowOf(raw)).toMatchObject({ state: 'revoked', credential_envelope: null });
		expect(cf.calls.some((call) => call.method === 'DELETE')).toBe(true);
		expect(audits.at(-1)).toEqual([ORG, 'plane.connection.revoke', connection.id]);
	});

	it('tells the owner to delete the token when Cloudflare will not', async () => {
		const { raw, deps } = await world({ deleteStatus: 403 });
		const { connection } = await connectCloudflare(deps, { orgId: ORG, token: GIVEN });
		const result = await revokeConnection(deps, ORG, connection.id, []);
		expect(result.tokenRemoval).toBe('owner-must-delete');
		expect(result.message).toContain(`Drupflare site connection ${connection.id}`);
		expect(rowOf(raw)!.credential_envelope).toBeNull();
	});

	it('only wipes a token the owner gave', async () => {
		const { deps, cf } = await world({ groupsReadable: false });
		const { connection } = await connectCloudflare(deps, { orgId: ORG, token: GIVEN });
		const result = await revokeConnection(deps, ORG, connection.id, []);
		expect(result.tokenRemoval).toBe('not-ours');
		expect(cf.calls.some((call) => call.method === 'DELETE')).toBe(false);
	});

	it('refuses while live sites use the account unless each is named', async () => {
		const { raw, deps } = await world({ groupsReadable: false });
		const { connection } = await connectCloudflare(deps, { orgId: ORG, token: GIVEN });
		addSelfManagedSite(raw, 'site_one');
		addSelfManagedSite(raw, 'site_two');
		addSelfManagedSite(raw, 'site_gone', 'tombstoned');
		const error = await refusal(revokeConnection(deps, ORG, connection.id, ['site_one']));
		expect(reasonOf(error)).toBe('sites_use_connection');
		expect((error.details as { siteIds: string[] }).siteIds).toEqual(['site_two']);
		expect(rowOf(raw)!.state).toBe('active');
		const done = await revokeConnection(deps, ORG, connection.id, ['site_one', 'site_two']);
		expect(done.connection.state).toBe('revoked');
	});

	it('answers a second revoke without changing anything', async () => {
		const { deps, audits } = await world({ groupsReadable: false });
		const { connection } = await connectCloudflare(deps, { orgId: ORG, token: GIVEN });
		await revokeConnection(deps, ORG, connection.id, []);
		const again = await revokeConnection(deps, ORG, connection.id, []);
		expect(again.message).toContain('already revoked');
		expect(audits.filter((entry) => entry[1] === 'plane.connection.revoke')).toHaveLength(1);
	});

	it('answers not found for another organisation', async () => {
		const { deps } = await world({ groupsReadable: false });
		const { connection } = await connectCloudflare(deps, { orgId: ORG, token: GIVEN });
		expect((await refusal(revokeConnection(deps, OTHER, connection.id, []))).code).toBe(
			'not_found'
		);
	});
});

describe('where a token can end up', () => {
	function dump(raw: Raw): string {
		const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
			name: string;
		}[];
		return JSON.stringify(
			tables.map(({ name }) => [name, raw.prepare(`SELECT * FROM "${name}"`).all()])
		);
	}

	it('leaves neither token in any table, response, audit entry or call body', async () => {
		const { raw, deps, cf, audits } = await world();
		const connected = await connectCloudflare(deps, { orgId: ORG, token: GIVEN });
		const checked = await validateConnection(deps, ORG, connected.connection.id);
		const listed = await listPlaneConnections(deps, ORG);
		const live = dump(raw);
		const revoked = await revokeConnection(deps, ORG, connected.connection.id, []);
		const surface = JSON.stringify([connected, checked, listed, revoked, audits]);
		for (const secret of [GIVEN, NARROW]) {
			expect(surface).not.toContain(secret);
			expect(live).not.toContain(secret);
			expect(dump(raw)).not.toContain(secret);
			expect(cf.calls.some((call) => call.body?.includes(secret))).toBe(false);
		}
	});
});

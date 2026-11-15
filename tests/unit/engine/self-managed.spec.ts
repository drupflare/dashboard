import { scriptName } from '@contracts/sites';
import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../../../contracts/src/common';
import {
	ConnectionUnavailableError,
	SELF_MANAGED_LIMITS,
	UnrecordedTargetError,
	connectionTokenOf,
	guardSelfManaged,
	selfManagedDepsOf,
	selfManagedPorts,
	type SelfManagedPorts
} from '../../../engine/src/adapters/self-managed';
import { siteTag, type LedgerRow } from '../../../engine/src/ownership';
import type { Cloudflare, EngineDeps } from '../../../engine/src/ports';
import { strataTokenName } from '../../../engine/src/provision-plan';
import { PermanentError } from '../../../engine/src/step';
import { encryptRecord, loadKeyRing } from '../../../src/shared/custody/envelope';
import { planeConnectionAad } from '../../../src/shared/custody/records';
import { memoryD1 } from './fakes';

const SITE = `site_${'s'.repeat(26)}`;
const ACCOUNT = 'a'.repeat(32);
const TOKEN = 'stored-token-value-0123456789';
const KEK = { KEK_V1: toBase64Url(new Uint8Array(32).fill(5)) };

const row = (over: Partial<LedgerRow> = {}): LedgerRow => ({
	id: 'res_1',
	siteId: SITE,
	accountId: ACCOUNT,
	kind: 'kv',
	binding: 'CONFIG_KV',
	name: 's-x-config',
	providerId: 'kv-1',
	createdByOperation: 'op_1',
	createdAt: 1,
	missingAt: null,
	deletedAt: null,
	fingerprint: null,
	...over
});

// every method records its name and arguments; reads answer from the table below
function recording(scriptTags: string[] | null = null) {
	const calls: string[] = [];
	const note =
		(name: string) =>
		async (...args: unknown[]) => {
			calls.push(`${name} ${args.map(String).join(' ')}`.trim());
			return undefined as never;
		};
	const cloudflare: Cloudflare = {
		listResources: note('listResources'),
		getScript: async (name) => {
			calls.push(`getScript ${name}`);
			return scriptTags === null ? null : { tags: scriptTags, version: null };
		},
		listRoutes: note('listRoutes'),
		readUsage: note('readUsage'),
		findResource: note('findResource'),
		createResource: note('createResource'),
		deleteResource: note('deleteResource'),
		addRoute: note('addRoute'),
		removeRoute: note('removeRoute'),
		putScript: note('putScript'),
		deleteScript: note('deleteScript'),
		startAssetSession: note('startAssetSession'),
		uploadAssetBucket: note('uploadAssetBucket'),
		mintBucketToken: note('mintBucketToken'),
		deleteBucketTokens: note('deleteBucketTokens')
	};
	const ports: SelfManagedPorts = {
		cloudflare,
		account: { subdomain: note('subdomain'), enableWorkersDev: note('enableWorkersDev') },
		kv: { put: note('kvPut'), delete: note('kvDelete') }
	};
	return { ports, calls };
}

function guarded(rows: LedgerRow[], scriptTags: string[] | null = null) {
	const { ports, calls } = recording(scriptTags);
	const guard = guardSelfManaged(ports, {
		siteId: SITE,
		accountId: ACCOUNT,
		ledger: { all: async () => rows }
	});
	return { guard, calls };
}

async function refused(promise: Promise<unknown>): Promise<UnrecordedTargetError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(UnrecordedTargetError);
		expect((error as UnrecordedTargetError).code).toBe('unrecorded_target');
		return error as UnrecordedTargetError;
	}
	throw new Error('expected a refusal');
}

describe('the account guard on reads', () => {
	it('passes every read through with an empty ledger', async () => {
		const { guard, calls } = guarded([]);
		await guard.cloudflare.listResources('kv');
		await guard.cloudflare.getScript('anything');
		await guard.cloudflare.listRoutes('zone');
		await guard.cloudflare.readUsage();
		await guard.cloudflare.findResource('kv', 'name');
		await guard.account.subdomain();
		expect(calls).toHaveLength(6);
	});
});

describe('the account guard on resource writes', () => {
	it('creates only what an intent in this site ledger names', async () => {
		const intent = row({ providerId: null, name: 's-x-config' });
		const { guard, calls } = guarded([intent]);
		await guard.cloudflare.createResource('kv', 's-x-config');
		expect(calls).toEqual(['createResource kv s-x-config']);
		await refused(guard.cloudflare.createResource('kv', 'customer-sessions'));
		await refused(guard.cloudflare.createResource('r2', 's-x-config'));
		expect(calls).toHaveLength(1);
	});

	it('deletes only an id the ledger recorded for the right kind', async () => {
		const { guard, calls } = guarded([row()]);
		await guard.cloudflare.deleteResource('kv', 'kv-1');
		await refused(guard.cloudflare.deleteResource('kv', 'kv-customer'));
		await refused(guard.cloudflare.deleteResource('r2', 'kv-1'));
		expect(calls).toEqual(['deleteResource kv kv-1']);
	});

	it('ignores a deleted row, a row of another account and a row of another site', async () => {
		const { guard, calls } = guarded([
			row({ deletedAt: 5 }),
			row({ id: 'res_2', accountId: 'b'.repeat(32), providerId: 'kv-2' })
		]);
		await refused(guard.cloudflare.deleteResource('kv', 'kv-1'));
		await refused(guard.cloudflare.deleteResource('kv', 'kv-2'));
		expect(calls).toEqual([]);
	});

	it('refuses every delete when the ledger is empty', async () => {
		const { guard, calls } = guarded([]);
		for (const kind of ['kv', 'r2', 'd1'] as const) {
			await refused(guard.cloudflare.deleteResource(kind, 'whatever'));
		}
		await refused(guard.cloudflare.deleteScript(scriptName(SITE)));
		expect(calls).toEqual(['getScript ' + scriptName(SITE)]);
	});
});

describe('the account guard on scripts', () => {
	it('uploads and deletes the script of this site once the ledger holds its row', async () => {
		const { guard, calls } = guarded([row({ kind: 'script', providerId: scriptName(SITE) })]);
		await guard.cloudflare.putScript(scriptName(SITE), {} as never);
		await guard.cloudflare.deleteScript(scriptName(SITE));
		await guard.cloudflare.startAssetSession(scriptName(SITE), {});
		await guard.cloudflare.uploadAssetBucket('jwt', []);
		await guard.account.enableWorkersDev(scriptName(SITE));
		expect(calls.map((call) => call.split(' ')[0])).toEqual([
			'putScript',
			'deleteScript',
			'startAssetSession',
			'uploadAssetBucket',
			'enableWorkersDev'
		]);
	});

	it('refuses a script the customer owns, even one named like ours', async () => {
		const { guard } = guarded([row({ kind: 'script', providerId: scriptName(SITE) })]);
		await refused(guard.cloudflare.putScript('customer-app', {} as never));
		await refused(guard.cloudflare.deleteScript('customer-app'));
		await refused(guard.cloudflare.startAssetSession('customer-app', {}));
		await refused(guard.account.enableWorkersDev('customer-app'));
	});

	it('adopts our own script with no row only when it carries this site marker', async () => {
		const mine = guarded([], [siteTag(SITE)]);
		await mine.guard.cloudflare.putScript(scriptName(SITE), {} as never);
		expect(mine.calls).toContain(`putScript ${scriptName(SITE)} [object Object]`);
		const theirs = guarded([], ['s:site_someone_else']);
		await refused(theirs.guard.cloudflare.putScript(scriptName(SITE), {} as never));
		const bare = guarded([], []);
		await refused(bare.guard.cloudflare.deleteScript(scriptName(SITE)));
	});

	it('refuses an asset upload when no script row exists', async () => {
		const { guard } = guarded([]);
		await refused(guard.cloudflare.uploadAssetBucket('jwt', []));
	});
});

describe('the account guard on routes, tokens and keys', () => {
	it('adds a route only for this script and a recorded intent, and removes only a recorded one', async () => {
		const { guard, calls } = guarded([
			row({ kind: 'route', providerId: null, name: 'www.example.org/*' }),
			row({ id: 'res_r', kind: 'route', providerId: 'zone:route-1', name: 'x' })
		]);
		await guard.cloudflare.addRoute('zone', 'www.example.org/*', scriptName(SITE));
		await refused(guard.cloudflare.addRoute('zone', 'www.example.org/*', 'customer-app'));
		await refused(guard.cloudflare.addRoute('zone', 'other.example.org/*', scriptName(SITE)));
		await guard.cloudflare.removeRoute('zone', 'route-1');
		await refused(guard.cloudflare.removeRoute('zone', 'route-9'));
		expect(calls).toHaveLength(2);
	});

	it('mints and deletes only the Strata token, on a recorded bucket', async () => {
		const { guard, calls } = guarded([row({ kind: 'r2', providerId: 'bucket-1' })]);
		await guard.cloudflare.mintBucketToken('bucket-1', strataTokenName(SITE));
		await guard.cloudflare.deleteBucketTokens(strataTokenName(SITE));
		await refused(guard.cloudflare.mintBucketToken('bucket-1', 'someone-else'));
		await refused(guard.cloudflare.mintBucketToken('customer-bucket', strataTokenName(SITE)));
		await refused(guard.cloudflare.deleteBucketTokens('someone-else'));
		expect(calls).toHaveLength(2);
	});

	it('writes and deletes a key only in a recorded namespace', async () => {
		const { guard, calls } = guarded([row()]);
		await guard.kv.put('kv-1', 'k', 'v');
		await guard.kv.delete('kv-1', 'k');
		await refused(guard.kv.put('kv-customer', 'k', 'v'));
		await refused(guard.kv.delete('kv-customer', 'k'));
		expect(calls).toEqual(['kvPut kv-1 k v', 'kvDelete kv-1 k']);
	});
});

describe('connectionTokenOf', () => {
	async function sealed(state: 'active' | 'invalid' | 'revoked' = 'active', envelope = true) {
		const { db, sqlite } = memoryD1();
		sqlite
			.prepare(
				`INSERT INTO sites (id, organization_id, name, plane, account_id, state, ready_at, created_at, updated_at)
				VALUES (?, 'org_1', 's', 'self-managed', ?, 'active', 1, 1, 1)`
			)
			.run(SITE, ACCOUNT);
		const ring = await loadKeyRing(KEK);
		const text = JSON.stringify(await encryptRecord(TOKEN, planeConnectionAad('pcn_1'), ring));
		sqlite
			.prepare(
				`INSERT INTO plane_connections (id, organization_id, provider, account_id, account_name,
				token_kind, minted, credential_envelope, capabilities, state, created_at, last_validated_at)
				VALUES ('pcn_1', 'org_1', 'cloudflare', ?, 'A', 'user', 0, ?, '[]', ?, 1, 1)`
			)
			.run(ACCOUNT, envelope ? text : null, state);
		return { db, sqlite, text };
	}

	const open = (
		db: Awaited<ReturnType<typeof sealed>>['db'],
		secrets: Record<string, string> = KEK
	) => connectionTokenOf({ db, secrets, siteId: SITE, accountId: ACCOUNT })();

	async function unavailable(promise: Promise<unknown>) {
		try {
			await promise;
		} catch (error) {
			expect(error).toBeInstanceOf(ConnectionUnavailableError);
			expect(error).toBeInstanceOf(PermanentError);
			return (error as ConnectionUnavailableError).message;
		}
		throw new Error('expected ConnectionUnavailableError');
	}

	it('opens the stored token for the site account', async () => {
		const { db } = await sealed();
		expect(await open(db)).toBe(TOKEN);
	});

	it('reads the row again on every call, so a revoke takes effect at once', async () => {
		const { db, sqlite } = await sealed();
		const read = connectionTokenOf({ db, secrets: KEK, siteId: SITE, accountId: ACCOUNT });
		expect(await read()).toBe(TOKEN);
		sqlite.exec("UPDATE plane_connections SET state = 'revoked', credential_envelope = NULL");
		expect(await unavailable(read())).toContain('no Cloudflare connection');
	});

	it('says which way the connection is unavailable', async () => {
		expect(await unavailable(open((await sealed('invalid')).db))).toContain('invalid');
		expect(await unavailable(open((await sealed('revoked')).db))).toContain(
			'no Cloudflare connection'
		);
		expect(await unavailable(open((await sealed('active', false)).db))).toContain('revoked');
		const { db } = await sealed();
		expect(
			await unavailable(
				connectionTokenOf({ db, secrets: KEK, siteId: SITE, accountId: 'c'.repeat(32) })()
			)
		).toContain('no Cloudflare connection');
	});

	it('fails closed when the key is wrong or the envelope was moved to another row', async () => {
		const { db, sqlite } = await sealed();
		expect(
			await unavailable(open(db, { KEK_V1: toBase64Url(new Uint8Array(32).fill(6)) }))
		).toContain('could not be opened');
		sqlite.exec("UPDATE plane_connections SET id = 'pcn_2'");
		expect(await unavailable(open(db))).toContain('could not be opened');
	});

	it('never puts the token in an error message', async () => {
		const { db } = await sealed('invalid');
		expect(await unavailable(open(db))).not.toContain(TOKEN);
	});
});

describe('selfManagedPorts', () => {
	const json = (result: unknown) =>
		new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});

	it('opens the token for each call and sends it, and keeps no copy between calls', async () => {
		const seen: (string | null)[] = [];
		let opens = 0;
		const ports = selfManagedPorts({
			accountId: ACCOUNT,
			open: async () => {
				opens++;
				return `${TOKEN}-${opens}`;
			},
			fetch: async (_input, init) => {
				seen.push(new Headers(init?.headers).get('authorization'));
				return json({ subdomain: 'acme' });
			}
		});
		await ports.account.subdomain();
		await ports.account.subdomain();
		expect(opens).toBe(2);
		expect(seen).toEqual([`Bearer ${TOKEN}-1`, `Bearer ${TOKEN}-2`]);
	});

	it('stops before any request when the token cannot be opened', async () => {
		let sent = 0;
		const ports = selfManagedPorts({
			accountId: ACCOUNT,
			open: async () => {
				throw new ConnectionUnavailableError('revoked');
			},
			fetch: async () => {
				sent++;
				return json([]);
			}
		});
		await expect(ports.cloudflare.listResources('kv')).rejects.toBeInstanceOf(
			ConnectionUnavailableError
		);
		await expect(ports.kv.put('ns', 'k', 'v')).rejects.toBeInstanceOf(
			ConnectionUnavailableError
		);
		expect(sent).toBe(0);
	});
});

describe('selfManagedDepsOf', () => {
	it('swaps in the account ports, drops the managed ones and refuses a stray call', async () => {
		const { ports } = recording();
		const base = {
			config: { account: { kvNamespaces: 1, buckets: 1 }, other: true },
			hostnames: {},
			domains: {}
		} as unknown as EngineDeps;
		const deps = selfManagedDepsOf(base, ports);
		expect(deps.cloudflare).toBe(ports.cloudflare);
		expect(deps.account).toBe(ports.account);
		expect((deps as { hostnames?: unknown }).hostnames).toBeUndefined();
		expect((deps as { domains?: unknown }).domains).toBeUndefined();
		expect(deps.config.account).toMatchObject(SELF_MANAGED_LIMITS);
		for (const call of [
			() => deps.authority.read(SITE),
			() => deps.authority.putHost('h', {} as never),
			() => deps.authority.deleteHostIfOwned('h', SITE),
			() => deps.names.reserve('n', SITE),
			() => deps.names.release('n', SITE)
		]) {
			await expect(call()).rejects.toMatchObject({ code: 'not_on_this_plane' });
		}
	});
});

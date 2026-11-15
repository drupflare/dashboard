import type { D1Database } from '@cloudflare/workers-types';
import { scriptName } from '@contracts/sites';
import {
	ApiError,
	Budget,
	Resources,
	Routing,
	cloudflare as accountPlane,
	readRateHeaders,
	type Fetcher
} from '@drupflare/workforce';
import { decryptRecordText, loadKeyRing, type KeyRing } from '../../../src/shared/custody/envelope';
import { PLANE_CONNECTION_SQL, planeConnectionAad } from '../../../src/shared/custody/records';
import type { LedgerRow, ResourceLedger } from '../ownership';
import { siteTag } from '../ownership';
import type { AccountHosts, Cloudflare, EngineDeps, NamespaceKv } from '../ports';
import { strataTokenName } from '../provision-plan';
import { PermanentError } from '../step';
import { namespaceKvOf } from './kv';
import { paced, workforceCloudflare } from './workforce';

// kv namespaces per account, and the highest Workers script limit Cloudflare publishes for any
// plan; both are unmeasured here, and a plan with a lower script limit is stopped by Cloudflare's own
// refusal, which the create step reports
export const SELF_MANAGED_LIMITS = { kvNamespaces: 1000, scripts: 500 } as const;

// #region the connection token

export class ConnectionUnavailableError extends PermanentError {
	constructor(why: 'missing' | 'invalid' | 'revoked' | 'sealed') {
		super(
			'connection_unavailable',
			why === 'missing'
				? 'no Cloudflare connection is recorded for this account; connect it again'
				: why === 'sealed'
					? 'the stored Cloudflare token could not be opened; connect the account again'
					: `the Cloudflare connection for this account is ${why}; check it and try again`
		);
	}
}

export interface ConnectionTokenOptions {
	db: D1Database;
	secrets: Readonly<Record<string, string | undefined>>;
	siteId: string;
	accountId: string;
}

interface ConnectionDbRow {
	id: string;
	organization_id: string;
	account_id: string;
	credential_envelope: string | null;
	token_kind: string;
	state: 'active' | 'invalid' | 'revoked';
}

// opens the sealed token for one call; the value is handed to that call and nothing here keeps it
export function connectionTokenOf(options: ConnectionTokenOptions): () => Promise<string> {
	let ring: Promise<KeyRing> | undefined;
	return async () => {
		const row = await options.db
			.prepare(PLANE_CONNECTION_SQL.forSite)
			.bind(options.siteId, options.accountId)
			.first<ConnectionDbRow>();
		if (row === null) throw new ConnectionUnavailableError('missing');
		if (row.state !== 'active') throw new ConnectionUnavailableError(row.state);
		if (row.credential_envelope === null) throw new ConnectionUnavailableError('revoked');
		ring ??= loadKeyRing(options.secrets);
		try {
			return await decryptRecordText(
				JSON.parse(row.credential_envelope),
				planeConnectionAad(row.id),
				await ring
			);
		} catch {
			throw new ConnectionUnavailableError('sealed');
		}
	};
}

// #endregion

// #region the executor

export interface SelfManagedPorts {
	cloudflare: Cloudflare;
	account: AccountHosts;
	kv: NamespaceKv;
}

export interface SelfManagedOptions {
	accountId: string;
	open: () => Promise<string>;
	fetch?: Fetcher;
}

const R2_NOT_ENABLED_CODE = 10042;

const isR2Off = (error: unknown) => error instanceof ApiError && error.hasCode(R2_NOT_ENABLED_CODE);

// every port call opens the token, builds an account plane for that call and lets both go; only the
// request budget is shared, and it holds no credential
export function selfManagedPorts(options: SelfManagedOptions): SelfManagedPorts {
	const budget = new Budget();
	async function using<T>(
		use: (plane: ReturnType<typeof accountPlane>, token: string) => Promise<T>
	): Promise<T> {
		const token = await options.open();
		const plane = accountPlane({
			accountId: options.accountId,
			token,
			budget,
			...(options.fetch === undefined ? {} : { fetch: options.fetch })
		});
		return use(plane, token);
	}
	const inner = (plane: ReturnType<typeof accountPlane>, token: string) =>
		workforceCloudflare(plane, new Resources(plane.http, options.accountId), token);

	const cloudflare: Cloudflare = {
		listResources: (kind) => using((plane, token) => inner(plane, token).listResources(kind)),
		// the account plane lists by search, since a plain script read answers with the script body
		getScript: (name) =>
			using(async (plane) => {
				const found = await paced(() => plane.get(name));
				return found === null ? null : { tags: [...found.tags], version: found.modifiedOn };
			}),
		listRoutes: (zoneId) => using((plane, token) => inner(plane, token).listRoutes(zoneId)),
		readUsage: () =>
			using(async (plane) => {
				const resources = new Resources(plane.http, options.accountId);
				const kvNamespaces = (await paced(() => resources.listKv())).length;
				let buckets = 0;
				let r2Enabled = true;
				try {
					buckets = (await paced(() => resources.listR2())).length;
				} catch (error) {
					if (!isR2Off(error)) throw error;
					r2Enabled = false;
				}
				const scripts = (await paced(() => plane.list())).length;
				const response = await paced(() =>
					plane.http.send(`/accounts/${options.accountId}/storage/kv/namespaces`, {
						query: { per_page: 5 }
					})
				);
				return {
					kvNamespaces,
					buckets,
					scripts,
					r2Enabled,
					rate: readRateHeaders(response.headers)
				};
			}),
		findResource: (kind, name) =>
			using((plane, token) => inner(plane, token).findResource(kind, name)),
		createResource: (kind, name) =>
			using(async (plane, token) => {
				try {
					return await inner(plane, token).createResource(kind, name);
				} catch (error) {
					if (isR2Off(error)) {
						throw new PermanentError(
							'r2_not_enabled',
							'the account has no object storage turned on, so the bucket was not created'
						);
					}
					throw error;
				}
			}),
		deleteResource: (kind, id) =>
			using((plane, token) => inner(plane, token).deleteResource(kind, id)),
		addRoute: (zoneId, pattern, script) =>
			using((plane, token) => inner(plane, token).addRoute(zoneId, pattern, script)),
		removeRoute: (zoneId, routeId) =>
			using((plane, token) => inner(plane, token).removeRoute(zoneId, routeId)),
		putScript: (name, upload) =>
			using((plane, token) => inner(plane, token).putScript(name, upload)),
		deleteScript: (name) => using((plane, token) => inner(plane, token).deleteScript(name)),
		startAssetSession: (script, manifest) =>
			using((plane, token) => inner(plane, token).startAssetSession(script, manifest)),
		uploadAssetBucket: (jwt, files) =>
			using((plane, token) => inner(plane, token).uploadAssetBucket(jwt, files)),
		mintBucketToken: (bucket, name) =>
			using((plane, token) => inner(plane, token).mintBucketToken(bucket, name)),
		deleteBucketTokens: (name) =>
			using((plane, token) => inner(plane, token).deleteBucketTokens(name))
	};

	const account: AccountHosts = {
		subdomain: () =>
			using((plane) =>
				paced(() => new Routing(plane.http, options.accountId).accountSubdomain())
			),
		async enableWorkersDev(script) {
			await using((plane) =>
				paced(() =>
					new Routing(plane.http, options.accountId).setSubdomain(script, {
						enabled: true
					})
				)
			);
		}
	};

	const kv: NamespaceKv = {
		put: (namespaceId, key, value) =>
			using((plane) => namespaceKvOf(plane).put(namespaceId, key, value)),
		delete: (namespaceId, key) =>
			using((plane) => namespaceKvOf(plane).delete(namespaceId, key))
	};

	return { cloudflare, account, kv };
}

// #endregion

// #region the account guard

export class UnrecordedTargetError extends PermanentError {
	constructor(action: string, target: string) {
		super(
			'unrecorded_target',
			`refused to ${action} ${target}: this site's ledger does not record it, so it is not ours`
		);
	}
}

export interface GuardScope {
	siteId: string;
	accountId: string;
	ledger: Pick<ResourceLedger, 'all'>;
}

// Reads pass through. A write or delete goes through only when the site's ledger names its target:
// an intent for a create, a live recorded id for anything else. A script with no row passes only when
// it already carries this site's marker tag, which is how an adoption of our own script is allowed.
export function guardSelfManaged(ports: SelfManagedPorts, scope: GuardScope): SelfManagedPorts {
	const { cloudflare: raw, account: rawAccount, kv: rawKv } = ports;
	const script = scriptName(scope.siteId);

	const rows = async (): Promise<LedgerRow[]> =>
		(await scope.ledger.all(scope.siteId)).filter(
			(row) => row.accountId === scope.accountId && row.deletedAt === null
		);

	const recorded = async (kind: LedgerRow['kind'], providerId: string) =>
		(await rows()).some((row) => row.kind === kind && row.providerId === providerId);

	const intended = async (kind: LedgerRow['kind'], name: string) =>
		(await rows()).some(
			(row) => row.kind === kind && row.providerId === null && row.name === name
		);

	const hasScriptRow = async () => (await rows()).some((row) => row.kind === 'script');

	// the script is ours when the ledger has a row for it, or the live script carries our marker
	async function ownsScript(name: string): Promise<boolean> {
		if (name !== script) return false;
		if (await hasScriptRow()) return true;
		const info = await raw.getScript(name);
		return info !== null && info.tags.includes(siteTag(scope.siteId));
	}

	const deny = (action: string, target: string): never => {
		throw new UnrecordedTargetError(action, target);
	};

	const cloudflare: Cloudflare = {
		listResources: (kind) => raw.listResources(kind),
		getScript: (name) => raw.getScript(name),
		listRoutes: (zoneId) => raw.listRoutes(zoneId),
		readUsage: () => raw.readUsage(),
		findResource: (kind, name) => raw.findResource(kind, name),
		async createResource(kind, name) {
			if (!(await intended(kind, name))) deny('create', `${kind} ${name}`);
			return raw.createResource(kind, name);
		},
		async deleteResource(kind, id) {
			if (!(await recorded(kind, id))) deny('delete', `${kind} ${id}`);
			return raw.deleteResource(kind, id);
		},
		async addRoute(zoneId, pattern, target) {
			if (target !== script || !(await intended('route', pattern))) {
				deny('add the route', pattern);
			}
			return raw.addRoute(zoneId, pattern, target);
		},
		async removeRoute(zoneId, routeId) {
			if (!(await recorded('route', `${zoneId}:${routeId}`)))
				deny('remove the route', routeId);
			return raw.removeRoute(zoneId, routeId);
		},
		async putScript(name, upload) {
			if (!(await ownsScript(name))) deny('upload', `script ${name}`);
			return raw.putScript(name, upload);
		},
		async deleteScript(name) {
			if (!(await ownsScript(name))) deny('delete', `script ${name}`);
			return raw.deleteScript(name);
		},
		async startAssetSession(target, manifest) {
			if (!(await ownsScript(target))) deny('open an asset session for', `script ${target}`);
			return raw.startAssetSession(target, manifest);
		},
		async uploadAssetBucket(jwt, files) {
			// the session token is bound to one script by Cloudflare; a site with no script row cannot hold one
			if (!(await hasScriptRow())) deny('upload assets for', `script ${script}`);
			return raw.uploadAssetBucket(jwt, files);
		},
		async mintBucketToken(bucket, name) {
			if (name !== strataTokenName(scope.siteId) || !(await recorded('r2', bucket))) {
				deny('mint a token for', `bucket ${bucket}`);
			}
			return raw.mintBucketToken(bucket, name);
		},
		async deleteBucketTokens(name) {
			if (name !== strataTokenName(scope.siteId)) deny('delete tokens named', name);
			return raw.deleteBucketTokens(name);
		}
	};

	const account: AccountHosts = {
		subdomain: () => rawAccount.subdomain(),
		async enableWorkersDev(target) {
			if (!(await ownsScript(target))) deny('turn on workers.dev for', `script ${target}`);
			return rawAccount.enableWorkersDev(target);
		}
	};

	const kv: NamespaceKv = {
		async put(namespaceId, key, value) {
			if (!(await recorded('kv', namespaceId)))
				deny('write a key in', `namespace ${namespaceId}`);
			return rawKv.put(namespaceId, key, value);
		},
		async delete(namespaceId, key) {
			if (!(await recorded('kv', namespaceId))) {
				deny('delete a key in', `namespace ${namespaceId}`);
			}
			return rawKv.delete(namespaceId, key);
		}
	};

	return { cloudflare, account, kv };
}

// #endregion

// #region the deps bundle

const refused = (what: string) => async (): Promise<never> => {
	throw new PermanentError(
		'not_on_this_plane',
		`${what} belongs to the managed plane, and a site in a customer account never calls it`
	);
};

// dispatch-only ports throw, so a call that slipped through cannot reach managed state
export function selfManagedDepsOf<D extends EngineDeps>(base: D, ports: SelfManagedPorts): D {
	return {
		...base,
		// custom hostnames are ours and ride the managed zone; a customer's account has none
		hostnames: undefined,
		domains: undefined,
		cloudflare: ports.cloudflare,
		kv: ports.kv,
		account: ports.account,
		authority: {
			read: refused('site authority'),
			apply: refused('site authority'),
			putHost: refused('the hosts table'),
			deleteHostIfOwned: refused('the hosts table')
		},
		names: {
			reserve: refused('the names registry'),
			confirm: refused('the names registry'),
			release: refused('the names registry')
		},
		config: {
			...base.config,
			account: { ...SELF_MANAGED_LIMITS }
		}
	} as D;
}

// #endregion

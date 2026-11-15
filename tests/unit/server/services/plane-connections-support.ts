import { toBase64Url } from '../../../../contracts/src/common';
import type { ProbeFetch } from '../../../../src/server/integrations/cloudflare-probe';
import type { PlaneConnectionDeps } from '../../../../src/server/services/plane-connections';
import { loadKeyRing } from '../../../../src/shared/custody/envelope';
import { sqliteClient } from '../fixtures/sqlite-client';

export const ORG = 'org_abcdefgh12345678';
export const OTHER = 'org_zzzzzzzz12345678';
export const ACCOUNT = 'a'.repeat(32);
export const SECOND = 'b'.repeat(32);
export const GIVEN = 'given-token-value-0123456789';
export const NARROW = 'narrow-token-value-0123456789';
const API = '/client/v4';

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (result: unknown) => json({ success: true, errors: [], messages: [], result });
const refused = () => json({ success: false, errors: [{ code: 9109 }] }, 403);

export interface Account {
	denied: Set<string>;
	groupsReadable: boolean;
	mintStatus: number;
	deleteStatus: number;
	subdomain: string | null;
	accounts: { id: string; name: string }[];
	verify: 'active' | 'expired' | 'throw';
	// the narrower token is refused every read, as when a mint went wrong
	narrowBroken: boolean;
}

// a Cloudflare that answers the probe, the permission group list, the mint and the delete
export function cloudflare(over: Partial<Account> = {}) {
	const state: Account = {
		denied: new Set(),
		groupsReadable: true,
		mintStatus: 200,
		deleteStatus: 200,
		subdomain: 'acme',
		accounts: [{ id: ACCOUNT, name: 'Campus Site' }],
		verify: 'active',
		narrowBroken: false,
		...over
	};
	const calls: { method: string; path: string; token: string; body: string | null }[] = [];
	const fetch: ProbeFetch = async (input, init) => {
		const path = new URL(input).pathname.replace(API, '');
		const method = init?.method ?? 'GET';
		const token = (new Headers(init?.headers).get('authorization') ?? '').replace(
			'Bearer ',
			''
		);
		calls.push({
			method,
			path,
			token,
			body: typeof init?.body === 'string' ? init.body : null
		});
		if (path === '/user/tokens/verify') {
			if (state.verify === 'throw') throw new TypeError('socket reset');
			return ok({ id: 'tok_1', status: state.verify });
		}
		if (path === '/accounts') return ok(state.accounts);
		if (path === '/user/tokens/permission_groups') {
			if (!state.groupsReadable) return refused();
			return ok(
				[
					'Workers Scripts Write',
					'Workers KV Storage Write',
					'Workers R2 Storage Write',
					'D1 Write',
					'Workers Routes Write'
				].map((name) => ({ id: `g_${name}`, name, scopes: ['com.cloudflare.api.account'] }))
			);
		}
		if (path === '/user/tokens' && method === 'POST') {
			if (state.mintStatus !== 200) return json({ success: false }, state.mintStatus);
			return ok({ id: 'tok_narrow', value: NARROW });
		}
		if (path === '/user/tokens/tok_narrow' && method === 'DELETE') {
			return state.deleteStatus === 200 ? ok({ id: 'tok_narrow' }) : refused();
		}
		if (path.endsWith('/workers/subdomain')) {
			if (state.subdomain === null) return json({ success: false }, 404);
			return ok({ subdomain: state.subdomain });
		}
		const read = /\/accounts\/[0-9a-f]+\/(.+)$/.exec(path)?.[1];
		if (read !== undefined) {
			if (state.narrowBroken && token === NARROW) return refused();
			return state.denied.has(read) ? refused() : ok([]);
		}
		return json({ success: false }, 404);
	};
	return { fetch, calls, state };
}

export async function world(over: Partial<Account> = {}) {
	const { raw, client } = sqliteClient();
	const cf = cloudflare(over);
	const ring = await loadKeyRing({ KEK_V1: toBase64Url(new Uint8Array(32).fill(9)) });
	const audits: [string, string, string][] = [];
	let clock = 1_000;
	const deps: PlaneConnectionDeps = {
		getDb: async () => client,
		ring: async () => ring,
		fetch: cf.fetch,
		now: () => ++clock,
		audit: async (orgId, action, targetId) => {
			audits.push([orgId, action, targetId]);
		}
	};
	return { raw, deps, cf, ring, audits };
}

export function addSelfManagedSite(
	raw: ReturnType<typeof sqliteClient>['raw'],
	id: string,
	state = 'active'
) {
	raw.prepare(
		`INSERT INTO sites (id, organization_id, name, plane, account_id, state, ready_at, created_at, updated_at)
			VALUES (?, ?, ?, 'self-managed', ?, ?, 1, 1, 1)`
	).run(id, ORG, id, ACCOUNT, state);
}

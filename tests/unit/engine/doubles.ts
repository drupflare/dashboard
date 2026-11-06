import type { KVNamespace, R2Bucket } from '@cloudflare/workers-types';
import { toBase64Url, type SigningKey } from '../../../contracts/src/common';
import { Names } from '../../../dispatch/src/names';
import { SiteAuth } from '../../../dispatch/src/site-auth';
import type { SiteAuthStub } from '../../../engine/src/adapters/authority';
import type { LeaseStub } from '../../../engine/src/adapters/leases';
import type { NamesStub } from '../../../engine/src/adapters/names';
import { SiteLease } from '../../../engine/src/site-lease';
import { memoryKv } from '../dispatch/fakes';

// the specs that import this file mock cloudflare:workers, so the real classes run in plain node

type Kv = ReturnType<typeof memoryKv>;

// a stub call is async and hands back a copy, as an RPC call does
function rpc<S>(target: object): S {
	return new Proxy(target, {
		get(object, name) {
			const value = Reflect.get(object, name);
			if (typeof value !== 'function') return value;
			return async (...args: unknown[]) =>
				structuredClone(await value.apply(object, args)) as unknown;
		}
	}) as S;
}

// each stub call builds a new instance over the stored data, which is what an evicted object looks like
function objectsOf<S>(make: (ctx: object, name: string) => object) {
	const stores = new Map<string, Kv>();
	const kvOf = (name: string): Kv => {
		let kv = stores.get(name);
		if (kv === undefined) stores.set(name, (kv = memoryKv()));
		return kv;
	};
	return {
		stores,
		kvOf,
		stub: (name: string): S => rpc<S>(make({ storage: { kv: kvOf(name) }, id: { name } }, name))
	};
}

export function siteAuthObjects(control: SigningKey) {
	const env = {
		SITE_AUTH_SEED: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
		CONTROL_PUBLIC_KEY: control.publicKey
	};
	return objectsOf<SiteAuthStub>((ctx) => new SiteAuth(ctx as never, env));
}

export function namesObjects() {
	return objectsOf<NamesStub>((ctx) => new Names(ctx as never, {}));
}

export function leaseObjects() {
	return objectsOf<LeaseStub>((ctx) => new SiteLease(ctx as never, {}));
}

export function hostsKv() {
	const map = new Map<string, string>();
	const kv = {
		get: async (key: string) => map.get(key) ?? null,
		put: async (key: string, value: string) => void map.set(key, value),
		delete: async (key: string) => void map.delete(key)
	} as unknown as KVNamespace;
	return { kv, map };
}

export function bucketOf(objects: Map<string, Uint8Array | string>): R2Bucket {
	return {
		get: async (key: string) => {
			const value = objects.get(key);
			if (value === undefined) return null;
			const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
			return {
				json: async () => JSON.parse(new TextDecoder().decode(bytes)),
				arrayBuffer: async () =>
					bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
			};
		}
	} as unknown as R2Bucket;
}

export interface SiteAnswer {
	status: number;
	fail: boolean;
	hang: boolean;
	calls: string[];
	body?: string;
	// the authorization header of each call, in order; kept apart from `calls`
	authorizations?: (string | null)[];
}

export function siteFetch(answer: SiteAnswer): typeof fetch {
	return (async (input: string | URL, init: RequestInit) => {
		answer.calls.push(`${init.method} ${String(input)} ${init.redirect}`);
		answer.authorizations?.push(new Headers(init.headers).get('authorization'));
		if (answer.fail) throw new TypeError('connection refused');
		if (answer.hang) {
			return new Promise((_, reject) =>
				init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
			);
		}
		return new Response(answer.body ?? null, { status: answer.status });
	}) as unknown as typeof fetch;
}

export const newAnswer = (status = 200): SiteAnswer => ({
	status,
	fail: false,
	hang: false,
	calls: []
});

import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';

export const REPO_CONFIG = fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url));
export const TWO_SHARD_CONFIG = fileURLToPath(
	new URL('./fixtures/two-shards.jsonc', import.meta.url)
);

export interface Bindings {
	KV: KVNamespace;
	DB: D1Database;
	[binding: string]: unknown;
}

export interface OpenBindings {
	env: Bindings;
	close: () => Promise<void>;
}

export async function openBindings(configPath = REPO_CONFIG): Promise<OpenBindings> {
	const persist = await mkdtemp(join(tmpdir(), 'drupflare-bindings-'));
	const proxy = await getPlatformProxy<Bindings>({
		configPath,
		persist: { path: persist },
		remoteBindings: false
	});
	return {
		env: proxy.env,
		async close() {
			await proxy.dispose();
			await rm(persist, { recursive: true, force: true });
		}
	};
}

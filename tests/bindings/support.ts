import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import { toBase64Url } from '../../contracts/src/common';
import {
	collegePendingSecretStore,
	setPendingSecretDeps
} from '../../src/server/services/owner-tokens';
import { loadKeyRing } from '../../src/shared/custody/envelope';

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

// the secret store the site reads ask for; the ring holds one key the tests never use to decrypt
export function installPendingSecrets(
	getDb: () => Promise<CollegeDBClient>,
	now: () => number = () => Date.now()
): void {
	setPendingSecretDeps(async () => ({
		store: collegePendingSecretStore(getDb),
		audit: { append: async () => undefined },
		ring: await loadKeyRing({ KEK_V1: toBase64Url(new Uint8Array(32).fill(1)) }),
		now
	}));
}

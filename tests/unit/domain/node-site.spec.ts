import { describe, expect, it } from 'vitest';
import {
	NODE_SITE_CODES,
	SITE_ADD_TTL_MS,
	checkNodeSite,
	payloadOf,
	readSiteAdd,
	siteAddRequest,
	type NodeSiteFacts
} from '../../../src/server/domain/node-site';
import { LINK_FRESH_MS } from '../../../src/shared/nodes';
import { nodeSiteFailureReason } from '../../../src/shared/operation-copy';

const NOW = 1_800_000_000_000;
const DIGEST = `sha256:${'cd'.repeat(32)}`;
const URL = 'https://releases.example.org/drupal-1.0.5.tar.gz';

const facts = (patch: Partial<NodeSiteFacts> = {}): NodeSiteFacts => ({
	kind: 'drupal',
	host: 'www.example.org',
	orgId: 'org_1',
	now: NOW,
	node: { id: 'nod_1', orgId: 'org_1', state: 'active', lastSeenAt: NOW - 1000 },
	nodes: 1,
	release: 'v1.0.5',
	claim: null,
	holderLive: false,
	...patch
});

const code = (patch: Partial<NodeSiteFacts>) => {
	const verdict = checkNodeSite(facts(patch));
	return verdict.ok ? 'ok' : verdict.code;
};

describe('checkNodeSite', () => {
	it('accepts a connected box in the same organization and normalizes the host', () => {
		expect(checkNodeSite(facts({ host: ' WWW.Example.ORG ' }))).toEqual({
			ok: true,
			hostname: 'www.example.org'
		});
	});

	it('refuses each precondition with its own code', () => {
		expect(code({ kind: 'workers' as never })).toBe('unsupported_kind');
		expect(code({ node: null })).toBe('node_not_found');
		expect(
			code({ node: { id: 'n', orgId: 'org_other', state: 'active', lastSeenAt: NOW } })
		).toBe('node_not_found');
		expect(code({ node: { id: 'n', orgId: 'org_1', state: 'revoked', lastSeenAt: NOW } })).toBe(
			'node_revoked'
		);
		expect(code({ node: { id: 'n', orgId: 'org_1', state: 'active', lastSeenAt: null } })).toBe(
			'node_offline'
		);
		expect(
			code({
				node: {
					id: 'n',
					orgId: 'org_1',
					state: 'active',
					lastSeenAt: NOW - LINK_FRESH_MS - 1
				}
			})
		).toBe('node_offline');
		expect(code({ nodes: 0 })).toBe('plan_no_nodes');
		expect(code({ release: undefined })).toBe('no_release');
		expect(code({ release: '' })).toBe('no_release');
		expect(code({ host: 'not a host' })).toBe('invalid');
		expect(code({ host: '*.example.org' })).toBe('wildcard');
		expect(code({ host: 'site.drupflare.app' })).toBe('platform_zone');
	});

	it('treats a plan that states no node figure as allowed', () => {
		expect(code({ nodes: null })).toBe('ok');
	});

	it('refuses an address another live site holds and lets a dead holder go', () => {
		const claim = {
			hostname: 'www.example.org',
			organizationId: 'org_other',
			siteId: 'site_x',
			operationId: 'op_x',
			epoch: 1,
			state: 'routed' as const,
			providerId: null,
			ownershipEpoch: null,
			updatedAt: 0
		};
		expect(code({ claim, holderLive: true })).toBe('host_taken');
		expect(code({ claim, holderLive: false })).toBe('ok');
	});

	it('gives every code a sentence', () => {
		for (const each of NODE_SITE_CODES) {
			expect(nodeSiteFailureReason(each).length).toBeGreaterThan(10);
		}
	});
});

describe('payloadOf', () => {
	const manifest = (assets: unknown[], kind = 'drupal-pack') => ({
		kind,
		version: '1.0.5',
		schemaVersion: 1,
		acceptsSchema: 1,
		assets
	});

	it('takes the archive asset with a url and a checksum the box accepts', () => {
		expect(
			payloadOf(manifest([{ name: 'drupal-1.0.5.tar.gz', url: URL, digest: DIGEST }]))
		).toEqual({ url: URL, checksum: DIGEST });
	});

	it('returns null for the wrong kind, a bad digest, a non-archive, http or garbage', () => {
		expect(
			payloadOf(manifest([{ name: 'a.tar.gz', url: URL, digest: DIGEST }], 'worker'))
		).toBeNull();
		expect(
			payloadOf(manifest([{ name: 'a.tar.gz', url: URL, digest: 'sha256:1' }]))
		).toBeNull();
		expect(payloadOf(manifest([{ name: 'a.zip', url: URL, digest: DIGEST }]))).toBeNull();
		expect(
			payloadOf(
				manifest([
					{ name: 'a.tar.gz', url: 'http://x.example.org/a.tar.gz', digest: DIGEST }
				])
			)
		).toBeNull();
		expect(payloadOf('nope')).toBeNull();
		expect(payloadOf(null)).toBeNull();
	});
});

describe('siteAddRequest', () => {
	it('is one stateful command with a stable key and nothing but the host, url and checksum', () => {
		const request = siteAddRequest('op_1', {
			host: 'www.example.org',
			payload: { url: URL, checksum: DIGEST }
		});
		expect(request).toEqual({
			opId: 'op_1',
			stepId: 'add',
			idempotencyKey: 'op_1:add',
			class: 'stateful',
			action: 'site.add',
			params: { host: 'www.example.org', bundle: URL, checksum: DIGEST },
			ttlMs: SITE_ADD_TTL_MS
		});
		expect(
			siteAddRequest('op_1', {
				host: 'www.example.org',
				payload: { url: URL, checksum: DIGEST }
			})
		).toEqual(request);
	});
});

describe('readSiteAdd', () => {
	const found = (result: unknown) =>
		readSiteAdd({ found: true, sent: true, result: result as never });

	it('reads every state the node session can hold', () => {
		expect(readSiteAdd({ found: false })).toEqual({ state: 'unsent' });
		expect(found(null)).toEqual({ state: 'waiting', queued: false });
		expect(found({ outcome: 'queued', code: null })).toEqual({
			state: 'waiting',
			queued: true
		});
		expect(found({ outcome: 'succeeded', code: null })).toEqual({ state: 'done' });
		expect(found({ outcome: 'expired', code: null })).toEqual({
			state: 'failed',
			code: 'not_approved'
		});
		expect(found({ outcome: 'failed', code: 'site_exists' })).toEqual({
			state: 'failed',
			code: 'site_exists'
		});
		expect(found({ outcome: 'rejected', code: 'unsupported_action' })).toEqual({
			state: 'failed',
			code: 'box_too_old'
		});
		expect(found({ outcome: 'failed', code: 'who-knows' })).toEqual({
			state: 'failed',
			code: 'box_failed'
		});
		expect(found({ outcome: 'failed', code: null })).toEqual({
			state: 'failed',
			code: 'box_failed'
		});
	});
});

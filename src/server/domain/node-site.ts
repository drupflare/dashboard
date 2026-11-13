import { releaseManifestSchema } from '@contracts/releases';
import type { SiteKind } from '@contracts/sites';
import { checkHostname } from '../../shared/domain-copy';
import { linkStateOf } from '../../shared/nodes';
import { decideClaim, type ClaimRow } from './domain-attach';
import type { CommandRecord, CommandRequest } from './fleet';

export const SITE_ADD_ACTION = 'site.add';
export const SITE_ADD_STEP = 'add';
// how long the box has to be approved and answer; the box refuses a command past this
export const SITE_ADD_TTL_MS = 15 * 60_000;

// the codes a start refuses with, and the codes a failed step carries; each has an owner sentence in
// operation-copy
export const NODE_SITE_CODES = [
	'unsupported_kind',
	'node_not_found',
	'node_revoked',
	'node_offline',
	'plan_no_nodes',
	'no_release',
	'invalid',
	'wildcard',
	'platform_zone',
	'host_taken',
	'no_payload',
	'box_too_old',
	'declined_at_box',
	'not_approved',
	'site_exists',
	'no_tenant',
	'unknown_tenant',
	'capacity_exceeded',
	'box_interrupted',
	'box_refused',
	'bundle_invalid',
	'assets_failed',
	'box_failed'
] as const;
export type NodeSiteCode = (typeof NODE_SITE_CODES)[number];

// #region the start

export interface NodeSiteFacts {
	kind: SiteKind;
	host: string;
	orgId: string;
	now: number;
	node: {
		id: string;
		orgId: string;
		state: 'active' | 'revoked';
		lastSeenAt: number | null;
	} | null;
	// the entitlement's node figure; null when the plan states none
	nodes: number | null;
	release: string | undefined;
	claim: ClaimRow | null;
	holderLive: boolean;
}

export type NodeSiteVerdict = { ok: true; hostname: string } | { ok: false; code: NodeSiteCode };

// everything the service can know before it writes anything; a node of another organization reads as
// missing, so its existence is not disclosed
export function checkNodeSite(facts: NodeSiteFacts): NodeSiteVerdict {
	if (facts.kind !== 'drupal') return { ok: false, code: 'unsupported_kind' };
	const { node } = facts;
	if (node === null || node.orgId !== facts.orgId) return { ok: false, code: 'node_not_found' };
	if (node.state === 'revoked') return { ok: false, code: 'node_revoked' };
	if (
		linkStateOf({ state: node.state, lastSeenAt: node.lastSeenAt }, facts.now) !== 'connected'
	) {
		return { ok: false, code: 'node_offline' };
	}
	if (facts.nodes !== null && facts.nodes <= 0) return { ok: false, code: 'plan_no_nodes' };
	if (facts.release === undefined || facts.release === '') {
		return { ok: false, code: 'no_release' };
	}
	const host = checkHostname(facts.host);
	if (!host.ok) return { ok: false, code: host.code };
	const decision = decideClaim(
		facts.claim,
		{ organizationId: facts.orgId, siteId: '' },
		facts.holderLive
	);
	if (decision.kind === 'refuse') return { ok: false, code: 'host_taken' };
	return { ok: true, hostname: host.hostname };
}

// #endregion

// #region the payload

// the shapes the box accepts for a bundle and a checksum; a value outside them would only come back
// as a refusal from the box
const BUNDLE_URL = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._~%/+=-]*$/;
const CHECKSUM = /^sha256:[0-9a-f]{64}$/;
const ARCHIVE = /\.(tar\.gz|tgz)$/;

export interface Payload {
	url: string;
	checksum: string;
}

// the release's own payload asset, and null when it publishes none the box could take
export function payloadOf(manifest: unknown): Payload | null {
	const parsed = releaseManifestSchema.safeParse(manifest);
	if (!parsed.success || parsed.data.kind !== 'drupal-pack') return null;
	const asset = parsed.data.assets.find(
		(entry) =>
			ARCHIVE.test(entry.name) && BUNDLE_URL.test(entry.url) && CHECKSUM.test(entry.digest)
	);
	return asset === undefined ? null : { url: asset.url, checksum: asset.digest };
}

// #endregion

// #region the command

// a command carries a host, a url and a checksum; the same key every time, so a resend is one command
export function siteAddRequest(
	operationId: string,
	input: { host: string; payload: Payload }
): CommandRequest {
	return {
		opId: operationId,
		stepId: SITE_ADD_STEP,
		idempotencyKey: `${operationId}:${SITE_ADD_STEP}`,
		class: 'stateful',
		action: SITE_ADD_ACTION,
		params: {
			host: input.host,
			bundle: input.payload.url,
			checksum: input.payload.checksum
		},
		ttlMs: SITE_ADD_TTL_MS
	};
}

export type SiteAddState =
	| { state: 'unsent' }
	| { state: 'waiting'; queued: boolean }
	| { state: 'done' }
	| { state: 'failed'; code: NodeSiteCode };

const BOX_CODES: Record<string, NodeSiteCode> = {
	site_exists: 'site_exists',
	no_tenant: 'no_tenant',
	unknown_tenant: 'unknown_tenant',
	'capacity-exceeded': 'capacity_exceeded',
	interrupted: 'box_interrupted',
	unsupported_action: 'box_too_old',
	rejected_by_operator: 'declined_at_box',
	invalid_params: 'box_refused',
	bundle_invalid: 'bundle_invalid',
	assets_failed: 'assets_failed',
	command_expired: 'not_approved',
	expired: 'not_approved'
};

// reads what the node session holds for the command; a command nobody has answered is waiting, and
// one the node holds for its operator's approval says so
export function readSiteAdd(
	status: { found: false } | { found: true; sent: boolean; result: CommandRecord['result'] }
): SiteAddState {
	if (!status.found) return { state: 'unsent' };
	const result = status.result;
	if (result === null) return { state: 'waiting', queued: false };
	switch (result.outcome) {
		case 'queued':
			return { state: 'waiting', queued: true };
		case 'succeeded':
			return { state: 'done' };
		case 'expired':
			return { state: 'failed', code: 'not_approved' };
		default:
			return { state: 'failed', code: BOX_CODES[result.code ?? ''] ?? 'box_failed' };
	}
}

// #endregion

import type { CollegeDBClient } from '@earth-app/collegedb';
import type { CapabilityId, ProbeReport } from '../../shared/cloudflare-probe';
import { decryptRecordText, encryptRecord, type KeyRing } from '../../shared/custody/envelope';
import { newPlaneConnectionId, planeConnectionAad } from '../../shared/custody/records';
import { ApiError } from '../../shared/errors';
import type {
	ConnectResult,
	PlaneConnectionView,
	RevokeResult
} from '../../shared/plane-connections';
import type { PlaneConnectionRow } from '../db/repos/plane-connections';
import * as repo from '../db/repos/plane-connections';
import {
	DownscopeError,
	deleteToken,
	mintNarrowToken,
	readWorkersSubdomain
} from '../integrations/cloudflare-connect';
import { probeCloudflareToken, type ProbeFetch } from '../integrations/cloudflare-probe';

// #region deps

export interface PlaneConnectionDeps {
	getDb: () => Promise<CollegeDBClient>;
	// loads on first use, so a missing key answers before anything is minted
	ring: () => Promise<KeyRing>;
	fetch: ProbeFetch;
	now: () => number;
	audit: (orgId: string, action: string, targetId: string) => Promise<void>;
}

let installed: PlaneConnectionDeps | null = null;

export function setPlaneConnectionDeps(deps: PlaneConnectionDeps | null): void {
	installed = deps;
}

export function planeConnectionDeps(): PlaneConnectionDeps {
	if (installed === null) {
		throw new ApiError('not_built', 'Cloudflare connections are not available yet');
	}
	return installed;
}

// #endregion

export function connectionView(row: PlaneConnectionRow): PlaneConnectionView {
	return {
		id: row.id,
		provider: row.provider,
		accountId: row.accountId,
		accountName: row.accountName,
		tokenKind: row.tokenKind,
		expiresOn: row.expiresOn,
		state: row.state,
		capabilities: row.capabilities,
		workersSubdomain: row.workersSubdomain,
		narrowerToken: row.minted,
		createdAt: row.createdAt,
		lastValidatedAt: row.lastValidatedAt,
		revokedAt: row.revokedAt
	};
}

const STATUS_WORDS: Record<string, string> = {
	expired: 'That token has expired. Make a new one and try again.',
	disabled: 'That token is disabled in Cloudflare. Turn it on or make a new one.',
	invalid: 'Cloudflare did not accept that token. Check that you copied all of it.',
	unknown: 'Cloudflare did not answer this check. Try again in a few minutes.'
};

function grantedOf(report: ProbeReport): CapabilityId[] {
	return report.capabilities.filter((item) => item.state === 'granted').map((item) => item.id);
}

const hasScripts = (report: ProbeReport) => grantedOf(report).includes('scripts');

async function sealToken(deps: PlaneConnectionDeps, id: string, token: string): Promise<string> {
	return JSON.stringify(await encryptRecord(token, planeConnectionAad(id), await deps.ring()));
}

// the token is opened for one call and handed to it; it is never returned or logged
export async function openToken(
	deps: PlaneConnectionDeps,
	row: PlaneConnectionRow
): Promise<string> {
	if (row.credentialEnvelope === null) {
		throw new ApiError('conflict', 'This connection holds no stored token', {
			reason: 'no_credential'
		});
	}
	return decryptRecordText(
		JSON.parse(row.credentialEnvelope),
		planeConnectionAad(row.id),
		await deps.ring()
	);
}

// #region connect

export interface ConnectInput {
	orgId: string;
	token: string;
	accountId?: string;
}

export async function connectCloudflare(
	deps: PlaneConnectionDeps,
	input: ConnectInput
): Promise<ConnectResult> {
	const report = await probeCloudflareToken({
		token: input.token,
		accountId: input.accountId,
		fetch: deps.fetch
	});
	if (report.status !== 'active') {
		throw new ApiError('unprocessable', STATUS_WORDS[report.status] ?? STATUS_WORDS.invalid!, {
			reason: `token_${report.status}`
		});
	}
	if (report.account === null) {
		throw new ApiError('unprocessable', 'That token cannot see a Cloudflare account.', {
			reason: 'no_account'
		});
	}
	if (input.accountId === undefined && report.accounts.length > 1) {
		throw new ApiError('unprocessable', 'That token sees more than one account. Choose one.', {
			reason: 'choose_account'
		});
	}
	if (!hasScripts(report)) {
		throw new ApiError(
			'unprocessable',
			'That token cannot edit Workers scripts, so nothing was stored.',
			{ reason: 'scripts_missing' }
		);
	}
	const db = await deps.getDb();
	const { account } = report;
	const existing = await repo.openConnectionForAccount(db, input.orgId, account.id);
	if (existing?.state === 'active') {
		throw new ApiError('conflict', 'This Cloudflare account is already connected.', {
			reason: 'already_connected',
			connectionId: existing.id
		});
	}
	const id = existing?.id ?? newPlaneConnectionId();
	// the key ring loads first, so a missing key stops the connect before a token is made
	await deps.ring();

	let stored = input.token;
	let tokenId = report.tokenId;
	let expiresOn = report.expiresOn;
	let minted = false;
	let capabilities = report.capabilities;
	if (report.canDownscope && report.kind !== null) {
		try {
			const made = await mintNarrowToken(
				{
					token: input.token,
					accountId: account.id,
					kind: report.kind,
					fetch: deps.fetch
				},
				grantedOf(report).filter((item) => item !== 'token-management'),
				`Drupflare site connection ${id}`
			);
			const check = await probeCloudflareToken({
				token: made.value,
				accountId: account.id,
				fetch: deps.fetch
			});
			if (check.status !== 'active' || !hasScripts(check)) {
				await deleteToken(
					{
						token: input.token,
						accountId: account.id,
						kind: report.kind,
						fetch: deps.fetch
					},
					made.id
				);
				throw new DownscopeError('The narrower token could not edit Workers scripts.');
			}
			stored = made.value;
			tokenId = made.id;
			expiresOn = null;
			minted = true;
			capabilities = check.capabilities;
		} catch (error) {
			if (!(error instanceof DownscopeError)) throw error;
			throw new ApiError(
				'unprocessable',
				`${error.message} Nothing was stored. Try again, or give a token without token-management permission.`,
				{ reason: error.code }
			);
		}
	}
	const subdomain = await readWorkersSubdomain({
		token: stored,
		accountId: account.id,
		fetch: deps.fetch
	});
	const now = deps.now();
	const row: PlaneConnectionRow = {
		id,
		organizationId: input.orgId,
		provider: 'cloudflare',
		accountId: account.id,
		accountName: account.name,
		tokenKind: report.kind ?? 'user',
		tokenId,
		minted,
		credentialEnvelope: await sealToken(deps, id, stored),
		capabilities,
		workersSubdomain: subdomain ?? null,
		expiresOn,
		state: 'active',
		createdAt: existing?.createdAt ?? now,
		lastValidatedAt: now,
		revokedAt: null
	};
	if (existing === null) await repo.insertPlaneConnection(db, row);
	else await repo.replaceCredential(db, input.orgId, row);
	await deps.audit(input.orgId, 'plane.connection.create', id);
	return {
		connection: connectionView(row),
		message: minted
			? 'Drupflare made a narrower token for this account and kept only that one, sealed. The token you gave was not kept.'
			: 'Drupflare kept the token you gave, sealed. It could not make a narrower one, so the token keeps every permission you gave it.'
	};
}

// #endregion

export async function listPlaneConnections(
	deps: PlaneConnectionDeps,
	orgId: string
): Promise<PlaneConnectionView[]> {
	return (await repo.listPlaneConnections(await deps.getDb(), orgId)).map(connectionView);
}

async function requireConnection(
	deps: PlaneConnectionDeps,
	orgId: string,
	id: string
): Promise<PlaneConnectionRow> {
	const row = await repo.getPlaneConnection(await deps.getDb(), orgId, id);
	if (row === null) throw new ApiError('not_found', 'Not found');
	return row;
}

// checks the stored token again and records what it found; a check that got no answer changes nothing
export async function validateConnection(
	deps: PlaneConnectionDeps,
	orgId: string,
	id: string
): Promise<PlaneConnectionView> {
	const row = await requireConnection(deps, orgId, id);
	if (row.state === 'revoked') {
		throw new ApiError('conflict', 'This connection was revoked.', { reason: 'revoked' });
	}
	const token = await openToken(deps, row);
	const report = await probeCloudflareToken({
		token,
		accountId: row.accountId,
		fetch: deps.fetch
	}).catch((error: unknown) => {
		if (error instanceof ApiError) return { ...EMPTY, status: 'invalid' as const };
		throw error;
	});
	if (report.status === 'unknown') {
		throw new ApiError('unprocessable', STATUS_WORDS.unknown!, { reason: 'unreachable' });
	}
	const state = report.status === 'active' && hasScripts(report) ? 'active' : 'invalid';
	const subdomain =
		state === 'active'
			? await readWorkersSubdomain({ token, accountId: row.accountId, fetch: deps.fetch })
			: undefined;
	const write = {
		state,
		capabilities: report.capabilities.length > 0 ? report.capabilities : row.capabilities,
		workersSubdomain: subdomain === undefined ? row.workersSubdomain : subdomain,
		expiresOn: report.expiresOn ?? row.expiresOn,
		now: deps.now()
	} as const;
	await repo.writeValidation(await deps.getDb(), orgId, id, write);
	return connectionView({
		...row,
		state,
		capabilities: write.capabilities,
		workersSubdomain: write.workersSubdomain,
		expiresOn: write.expiresOn,
		lastValidatedAt: write.now
	});
}

const EMPTY: ProbeReport = {
	status: 'invalid',
	kind: null,
	tokenId: null,
	expiresOn: null,
	accounts: [],
	account: null,
	capabilities: [],
	canDownscope: false
};

// refuses while live sites use the account, unless the caller names each one
export async function revokeConnection(
	deps: PlaneConnectionDeps,
	orgId: string,
	id: string,
	force: readonly string[]
): Promise<RevokeResult> {
	const row = await requireConnection(deps, orgId, id);
	const db = await deps.getDb();
	if (row.state === 'revoked') {
		return {
			connection: connectionView(row),
			tokenRemoval: 'not-ours',
			message: 'This connection was already revoked.'
		};
	}
	const using = await repo.liveSiteIdsOnAccount(db, orgId, row.accountId);
	const unnamed = using.filter((siteId) => !force.includes(siteId));
	if (unnamed.length > 0) {
		throw new ApiError(
			'conflict',
			'Sites still run on this account. Name each one to revoke anyway.',
			{ reason: 'sites_use_connection', siteIds: unnamed }
		);
	}
	let tokenRemoval: RevokeResult['tokenRemoval'] = 'not-ours';
	if (row.minted && row.tokenId !== null) {
		const token = await openToken(deps, row);
		const deleted = await deleteToken(
			{ token, accountId: row.accountId, kind: row.tokenKind, fetch: deps.fetch },
			row.tokenId
		);
		tokenRemoval = deleted ? 'deleted' : 'owner-must-delete';
	}
	await repo.revokePlaneConnection(db, orgId, id, deps.now());
	await deps.audit(orgId, 'plane.connection.revoke', id);
	return {
		connection: connectionView({ ...row, state: 'revoked', credentialEnvelope: null }),
		tokenRemoval,
		message:
			tokenRemoval === 'owner-must-delete'
				? `The stored token is wiped. Cloudflare would not let it delete itself, so delete the token named "Drupflare site connection ${row.id}" in your Cloudflare API Tokens page.`
				: tokenRemoval === 'deleted'
					? 'The stored token is wiped and the narrower token is deleted in Cloudflare.'
					: 'The stored token is wiped. The token you gave Drupflare stays in your Cloudflare account; delete it there if you no longer use it.'
	};
}

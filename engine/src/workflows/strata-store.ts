import type { StrataStoreReason } from '../../../src/shared/strata';
import { claimResource } from '../ownership';
import type { BucketToken, ModuleDeps } from '../ports';
import {
	resourceName,
	STRATA_STORE_BINDING,
	STRATA_STORE_SUFFIX,
	strataTokenName
} from '../provision-plan';
import { PermanentError } from '../step';
import { openSite, type OpenSite } from './backup-create';
import { fenced, runStep, type Ctx } from './common';
import { withOwnerToken, type ModuleInput } from './module-common';

export const STRATA_STORE_ATTEMPTS = 3;
export const STRATA_STORE_RETRY_MS = 2_000;
export const STRATA_S3_MODULE = 'strata_s3';
export const STRATA_STORE_REGION = 'auto';

export const strataEndpoint = (accountId: string) =>
	`https://${accountId}.r2.cloudflarestorage.com`;

type Result = { state: 'ready' } | { state: 'failed'; reason: StrataStoreReason };

const failed = (reason: StrataStoreReason): Result => ({ state: 'failed', reason });

function reasonOf(error: unknown, minted: boolean): StrataStoreReason {
	if (error instanceof PermanentError) {
		if (error.code === 'token_quota') return 'token_quota';
		if (error.code === 'owner_token_rejected') return 'site_refused';
		return 'storage_failed';
	}
	return minted ? 'site_refused' : 'storage_failed';
}

// the secret lives in `creds` for this one function; nothing it throws or returns carries it
async function provision(
	ctx: Ctx,
	deps: ModuleDeps,
	input: Pick<ModuleInput, 'orgId' | 'siteId' | 'accountId'>
): Promise<Result | null> {
	await fenced(ctx);
	const name = strataTokenName(input.siteId);
	const bucket = resourceName(input.siteId, STRATA_STORE_SUFFIX);
	let reason: StrataStoreReason = 'storage_failed';
	let creds: BucketToken | undefined;
	let site: OpenSite | undefined;
	let prepared = false;
	for (let attempt = 1; attempt <= STRATA_STORE_ATTEMPTS; attempt++) {
		try {
			site ??= await openSite(
				deps,
				{ id: input.siteId, orgId: input.orgId, accountId: input.accountId },
				{ notReady: 'site_not_ready', foreign: 'site_not_ready' }
			);
			// a customer's account has no executor here; the site owner points Strata at their own storage
			if (site.plane !== 'managed') return null;
			const open = site;
			if (!prepared) {
				const reading = await withOwnerToken(deps, input, open, (auth) =>
					deps.modules.read(open.hostname, STRATA_S3_MODULE, auth)
				);
				if (!reading.enabled) {
					const done = await withOwnerToken(deps, input, open, (auth) =>
						deps.modules.enable(open.hostname, STRATA_S3_MODULE, auth)
					);
					if (!done.ok)
						throw new PermanentError('storage_failed', 'the S3 part would not enable');
				}
				await claimResource(
					deps,
					{
						siteId: input.siteId,
						accountId: input.accountId,
						operationId: ctx.operationId,
						plane: open.plane
					},
					{ kind: 'r2', binding: STRATA_STORE_BINDING, name: bucket }
				);
				prepared = true;
			}
			if (creds === undefined) {
				await deps.cloudflare.deleteBucketTokens(name);
				creds = await deps.cloudflare.mintBucketToken(bucket, name);
			}
			const minted = creds;
			const answer = await withOwnerToken(deps, input, open, (auth) =>
				deps.modules.setStrataStore(
					open.hostname,
					{
						endpoint: strataEndpoint(input.accountId),
						bucket,
						region: STRATA_STORE_REGION,
						accessKeyId: minted.accessKeyId,
						secretAccessKey: minted.secretAccessKey,
						pathStyle: true,
						enable: true
					},
					auth
				)
			);
			if (answer.ok) return { state: 'ready' };
			if (answer.refusal === 'route_missing') {
				reason = 'site_needs_update';
				break;
			}
			reason = 'site_refused';
		} catch (error) {
			reason = reasonOf(error, creds !== undefined);
			if (error instanceof PermanentError) break;
		}
		if (attempt < STRATA_STORE_ATTEMPTS) await deps.sleep(STRATA_STORE_RETRY_MS);
	}
	// a token the site never took is no use, and it counts against the account's token quota
	if (creds !== undefined) await deps.cloudflare.deleteBucketTokens(name).catch(() => undefined);
	return failed(reason);
}

// the enable has already succeeded whatever this answers, and Strata ships off, so a failure is
// recorded for the owner and the operation goes on
export async function runStrataStore(
	ctx: Ctx,
	deps: ModuleDeps,
	input: Pick<ModuleInput, 'orgId' | 'siteId' | 'accountId'>
): Promise<void> {
	await runStep(ctx, 'strata-store', 'strata-store', async () => {
		const result = await provision(ctx, deps, input);
		if (result === null) return;
		await deps.strata.markStore(input.orgId, input.siteId, result);
	});
}

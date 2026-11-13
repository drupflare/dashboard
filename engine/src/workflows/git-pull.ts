import type { Plan } from '@contracts/operations';
import { failureReason } from '../../../src/shared/operation-copy';
import { SiteAnswered, SiteUnreachable } from '../adapters/site';
import { GitError, matchRemote, type GitPullResult, type GitRemoteSpec } from '../git-parts';
import { buildPlan, setVerification } from '../operations/state';
import type { GitDeps } from '../ports';
import { messageOf, StepFailed, type StepRunner } from '../step';
import { assertOperationOrg, openSite } from './backup-create';
import {
	acquireLease,
	closeFailed,
	describeFailure,
	fenced,
	finishSuccess,
	plainStep,
	releaseLease,
	runStep,
	startOperation,
	type Ctx,
	type Outcome
} from './common';

export interface GitPullInput {
	operationId: string;
	orgId: string;
	siteId: string;
	accountId: string;
	// the dashboard's own id for the attached repository
	remoteId: string;
}

export function planGitPull(input: Pick<GitPullInput, 'siteId'>): Plan {
	return buildPlan({
		type: 'git.pull',
		targetIds: [input.siteId],
		preconditions: [
			`${input.siteId} is active and has an owner token`,
			'the repository is attached to the site'
		],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'find', name: 'Find the repository on the site' },
			{ id: 'pull', name: 'Install the latest commit' },
			{ id: 'record', name: 'Record the result on the repository' }
		]
	});
}

interface Found {
	hostname: string;
	ownerTokenId: string;
	spec: GitRemoteSpec;
	// the site's own id for the repository, null when the site does not follow it yet
	siteRemoteId: string | null;
}

async function findRemote(ctx: Ctx, deps: GitDeps, input: GitPullInput): Promise<Found> {
	return runStep(ctx, 'find', 'find', async () => {
		await fenced(ctx);
		await assertOperationOrg(deps, ctx.operationId, input.orgId, 'site_not_ready');
		const site = await openSite(
			deps,
			{ id: input.siteId, orgId: input.orgId, accountId: input.accountId },
			{ notReady: 'site_not_ready', foreign: 'site_not_ready' }
		);
		const record = await deps.remotes.get(input.orgId, input.siteId, input.remoteId);
		if (record === null) {
			throw new GitError('remote_gone', 'the repository is no longer attached to this site');
		}
		const spec: GitRemoteSpec = {
			provider: record.provider,
			repo: record.repo,
			branch: record.branch,
			mountPath: record.mountPath
		};
		const listed = await deps.custody.withOwnerToken(
			input.siteId,
			site.ownerTokenId,
			(bearer) => deps.git.remotes(site.hostname, { bearer })
		);
		const match = matchRemote(listed, spec);
		if (match !== null && match.mount !== null && match.mount !== spec.mountPath) {
			throw new GitError(
				'remote_mount_differs',
				'the site follows this repository at another path'
			);
		}
		return {
			hostname: site.hostname,
			ownerTokenId: site.ownerTokenId,
			spec,
			siteRemoteId: match?.id ?? null
		};
	});
}

// a repeat after a lost answer pulls the same head again, which the site reads as no change
async function pullCommit(
	ctx: Ctx,
	deps: GitDeps,
	input: GitPullInput,
	found: Found
): Promise<GitPullResult> {
	return runStep(ctx, 'pull', 'pull', async () => {
		await fenced(ctx);
		const { hostname, siteRemoteId, spec } = found;
		const result = await deps.custody.withOwnerToken(
			input.siteId,
			found.ownerTokenId,
			(bearer) =>
				siteRemoteId === null
					? deps.tokenPull.pull({ hostname, siteId: input.siteId }, spec, { bearer })
					: deps.git.pull(hostname, siteRemoteId, { bearer })
		);
		// the site boots Drupal with the new files and puts the old ones back when it will not start
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.verification === 'passed'
				? operation
				: setVerification(operation, 'passed', deps.now())
		);
		return result;
	});
}

async function recordInstalled(ctx: Ctx, deps: GitDeps, input: GitPullInput): Promise<void> {
	await runStep(ctx, 'record', 'record', async () => {
		await fenced(ctx);
		await deps.remotes.record(input.remoteId, {
			status: 'installed',
			at: deps.now(),
			reason: null
		});
	});
}

// the owner reads this, so it names the cause in plain words and leaves the site's text to the step
function plainReason(failure: StepFailed): string {
	const cause = failure.reason;
	const unanswered = cause instanceof SiteUnreachable || cause instanceof SiteAnswered;
	return (
		failureReason({
			type: 'git.pull',
			status: 'failed',
			failedStep: failure.step,
			failedError: unanswered ? 'site_unreachable: no answer' : messageOf(cause)
		}) ?? 'Stopped before it could finish.'
	);
}

// the operation closes before the repository row is written, so a failed write never leaves it open
async function fail(
	ctx: Ctx,
	deps: GitDeps,
	input: GitPullInput,
	failure: StepFailed
): Promise<Outcome> {
	const reason = describeFailure(failure);
	const closed = await closeFailed(ctx, failure);
	await plainStep(ctx, 'record.failed', () =>
		deps.remotes.record(input.remoteId, {
			status: 'failed',
			at: deps.now(),
			reason: plainReason(failure)
		})
	);
	await releaseLease(ctx);
	return closed === 'cancelled'
		? { status: 'cancelled', reason }
		: { status: 'failed', reason, leaked: [] };
}

export async function runGitPull(
	step: StepRunner,
	deps: GitDeps,
	input: GitPullInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.siteId,
		accountId: input.accountId,
		purpose: 'git.pull',
		epoch: null
	};
	let found: Found;
	let pulled: GitPullResult;
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		found = await findRemote(ctx, deps, input);
		pulled = await pullCommit(ctx, deps, input, found);
		await recordInstalled(ctx, deps, input);
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		return fail(ctx, deps, input, error);
	}
	await finishSuccess(
		ctx,
		`${found.spec.repo} at ${found.spec.branch} is installed${pulled.sha === null ? '' : ` at ${pulled.sha.slice(0, 12)}`}, ${pulled.changed} files changed`
	);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}

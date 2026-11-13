import type { Plan } from '@contracts/operations';
import {
	SITE_ADD_STEP,
	SITE_ADD_TTL_MS,
	payloadOf,
	readSiteAdd,
	siteAddRequest,
	type NodeSiteCode,
	type Payload
} from '../../../src/server/domain/node-site';
import { nodeSiteFailureReason } from '../../../src/shared/operation-copy';
import { bundleKeys } from '../bundle';
import { buildPlan, setCursor } from '../operations/state';
import type { NodeSiteDeps } from '../ports';
import { PermanentError, StepFailed, type StepRunner } from '../step';
import {
	closeFailed,
	describeFailure,
	finishSuccess,
	plainStep,
	runStep,
	startOperation,
	type Ctx,
	type Outcome
} from './common';

export interface NodeSiteCreateInput {
	operationId: string;
	orgId: string;
	siteId: string;
	nodeId: string;
	hostname: string;
	releaseId: string;
}

// the runner of a workflow that waits on a person at another machine; a sleep costs no step budget
export interface NodeRunner extends StepRunner {
	sleep(name: string, ms: number): Promise<void>;
}

export function planNodeSiteCreate(input: Pick<NodeSiteCreateInput, 'siteId' | 'hostname'>): Plan {
	return buildPlan({
		type: 'node.command',
		targetIds: [input.siteId],
		preconditions: [
			'the box is paired, connected and not revoked',
			`${input.hostname} is a name no other site holds`,
			'the current release publishes a payload for a box'
		],
		steps: [
			{ id: 'claim', name: `Claim ${input.hostname} for this site` },
			{ id: 'payload', name: 'Find the site files for the current release' },
			{ id: 'add', name: 'Send the request to the box' },
			{ id: 'wait', name: 'Wait for the box to add the site' },
			{ id: 'activate', name: 'Mark the site ready on the box' }
		],
		rollbackPoint: 'before the box adds the site'
	});
}

// what the page can read from the operation's cursor while the box has not answered
export interface WaitCursor {
	v: 1;
	startedAt: number;
	phase: 'sent' | 'queued';
}

export function readWaitCursor(cursor: string | null): WaitCursor | null {
	if (cursor === null) return null;
	try {
		const parsed = JSON.parse(cursor) as Partial<WaitCursor>;
		return parsed.v === 1 &&
			typeof parsed.startedAt === 'number' &&
			(parsed.phase === 'sent' || parsed.phase === 'queued')
			? (parsed as WaitCursor)
			: null;
	} catch {
		return null;
	}
}

export function pollDelayMs(attempt: number): number {
	return attempt < 6 ? 10_000 : 30_000;
}

// a little past the command's own expiry, so the box's answer of expired is read before this gives up
const GIVE_UP_MS = SITE_ADD_TTL_MS + 60_000;

const fail = (code: NodeSiteCode): PermanentError =>
	new PermanentError(code, nodeSiteFailureReason(code));

async function assertBox(deps: NodeSiteDeps, input: NodeSiteCreateInput): Promise<void> {
	const node = await deps.nodes.node(input.nodeId);
	if (node === null || node.orgId !== input.orgId) throw fail('node_not_found');
	if (node.state !== 'active') throw fail('node_revoked');
}

async function claimHost(
	ctx: Ctx,
	deps: NodeSiteDeps,
	input: NodeSiteCreateInput
): Promise<{ epoch: number }> {
	return runStep(ctx, 'claim', 'claim', async () => {
		const site = await deps.sites.get(input.siteId);
		if (
			site === null ||
			site.organizationId !== input.orgId ||
			site.plane !== 'self-hosted' ||
			site.state !== 'active'
		) {
			throw new PermanentError(
				'site_not_ready',
				`${input.siteId} is not a site being created`
			);
		}
		await assertBox(deps, input);
		const claim = await deps.domains.claim(
			input.hostname,
			{ organizationId: input.orgId, siteId: input.siteId, operationId: ctx.operationId },
			deps.now()
		);
		if (!claim.ok) throw fail('host_taken');
		return { epoch: claim.epoch };
	});
}

async function findPayload(
	ctx: Ctx,
	deps: NodeSiteDeps,
	input: NodeSiteCreateInput
): Promise<Payload> {
	return runStep(ctx, 'payload', 'payload', async () => {
		let bytes: Uint8Array;
		try {
			bytes = await deps.releases.part(bundleKeys.payload(input.releaseId));
		} catch (error) {
			if (error instanceof PermanentError && error.code === 'release_part_missing') {
				throw fail('no_payload');
			}
			throw error;
		}
		let manifest: unknown = null;
		try {
			manifest = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			manifest = null;
		}
		const payload = payloadOf(manifest);
		if (payload === null) throw fail('no_payload');
		return payload;
	});
}

async function sendRequest(
	ctx: Ctx,
	deps: NodeSiteDeps,
	input: NodeSiteCreateInput,
	payload: Payload
): Promise<void> {
	const sent = await deps.nodes.send(
		input.nodeId,
		siteAddRequest(ctx.operationId, { host: input.hostname, payload })
	);
	if (sent.ok) return;
	if (sent.code === 'node_revoked') throw fail('node_revoked');
	if (sent.code === 'unknown_node') throw fail('node_not_found');
	throw fail('box_failed');
}

async function sendCommand(
	ctx: Ctx,
	deps: NodeSiteDeps,
	input: NodeSiteCreateInput,
	payload: Payload
): Promise<void> {
	await runStep(ctx, 'add', 'add', async () => {
		await assertBox(deps, input);
		await sendRequest(ctx, deps, input, payload);
		const startedAt = deps.now();
		await deps.store.mutate(ctx.operationId, (operation) =>
			readWaitCursor(operation.cursor) !== null
				? operation
				: setCursor(
						operation,
						JSON.stringify({ v: 1, startedAt, phase: 'sent' } satisfies WaitCursor),
						deps.now()
					)
		);
	});
}

// every poll is one workflow step and every wait a sleep; the box queues a stateful command for its
// operator, so the wait is expected to last as long as that takes, up to the command's expiry
async function awaitBox(
	ctx: Ctx,
	deps: NodeSiteDeps,
	input: NodeSiteCreateInput,
	step: NodeRunner,
	payload: Payload
): Promise<void> {
	await runStep(ctx, 'wait.begin', 'wait', async () => undefined, { finish: false });
	const ref = {
		opId: ctx.operationId,
		stepId: SITE_ADD_STEP,
		idempotencyKey: `${ctx.operationId}:${SITE_ADD_STEP}`
	};
	for (let attempt = 0; ; attempt++) {
		const done = await runStep(
			ctx,
			`wait.poll.${attempt}`,
			'wait',
			async () => {
				await assertBox(deps, input);
				const state = readSiteAdd(await deps.nodes.status(input.nodeId, ref));
				if (state.state === 'failed') throw fail(state.code);
				if (state.state === 'done') return true;
				if (state.state === 'unsent') await sendRequest(ctx, deps, input, payload);
				const operation = await deps.store.get(ctx.operationId);
				const held = readWaitCursor(operation?.cursor ?? null);
				const startedAt = held?.startedAt ?? deps.now();
				const phase = state.state === 'waiting' && state.queued ? 'queued' : 'sent';
				if (held?.phase !== phase) {
					await deps.store.mutate(ctx.operationId, (current) =>
						setCursor(
							current,
							JSON.stringify({ v: 1, startedAt, phase } satisfies WaitCursor),
							deps.now()
						)
					);
				}
				if (deps.now() - startedAt >= GIVE_UP_MS) throw fail('not_approved');
				return false;
			},
			{ begin: false, finish: false }
		);
		if (done) break;
		await step.sleep(`wait.sleep.${attempt}`, pollDelayMs(attempt));
	}
	await runStep(ctx, 'wait.end', 'wait', async () => undefined, { begin: false });
}

async function activate(
	ctx: Ctx,
	deps: NodeSiteDeps,
	input: NodeSiteCreateInput,
	claimed: { epoch: number }
): Promise<void> {
	await runStep(ctx, 'activate', 'activate', async () => {
		await deps.sites.bind(input.siteId, input.nodeId, input.releaseId, deps.now());
		if (!(await deps.domains.markRouted(input.hostname, claimed.epoch, input.siteId))) {
			throw fail('host_taken');
		}
	});
}

// a failed create makes no site: the claim goes back and the row it wrote stops counting. A box
// that added its site before the failure keeps it, and a new create of the same host adopts it
async function unwind(ctx: Ctx, deps: NodeSiteDeps, input: NodeSiteCreateInput): Promise<string[]> {
	try {
		await plainStep(ctx, 'unwind', async () => {
			const row = await deps.domains.current(input.hostname);
			if (row !== null && row.operationId === ctx.operationId && row.state !== 'released') {
				await deps.domains.release(input.hostname, row.epoch, input.siteId);
			}
			await deps.sites.retire(input.siteId, deps.now());
		});
		return [];
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		return [`site:${input.siteId}`];
	}
}

export async function runNodeSiteCreate(
	step: NodeRunner,
	deps: NodeSiteDeps,
	input: NodeSiteCreateInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.siteId,
		accountId: input.orgId,
		purpose: 'node.command',
		epoch: null
	};
	try {
		await startOperation(ctx);
		const claimed = await claimHost(ctx, deps, input);
		const payload = await findPayload(ctx, deps, input);
		await sendCommand(ctx, deps, input, payload);
		await awaitBox(ctx, deps, input, step, payload);
		await activate(ctx, deps, input, claimed);
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		const reason = describeFailure(error);
		const closed = await closeFailed(ctx, error);
		const leaked = await unwind(ctx, deps, input);
		return closed === 'cancelled'
			? { status: 'cancelled', reason }
			: { status: 'failed', reason, leaked };
	}
	await finishSuccess(ctx, `${input.hostname} is added on the box and listed as a site`);
	return { status: 'succeeded' };
}

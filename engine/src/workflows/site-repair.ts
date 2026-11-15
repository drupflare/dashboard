import type { Plan } from '@contracts/operations';
import { admitRepair, autoRepairOn, HOUR_MS } from '../../../src/server/domain/incidents';
import { attemptBlocker, blocker, type LadderFacts } from '../../../src/server/domain/ladder';
import {
	assertCatalogued,
	CATALOGUE,
	UncataloguedRepairError,
	type CatalogueRow
} from '../../../src/shared/health/catalogue';
import { evaluatePredicate } from '../../../src/shared/health/predicate';
import type { Rung } from '../../../src/shared/health/vocab';
import { buildPlan, observe, setVerification, skipPending, transition } from '../operations/state';
import type { RepairDeps, RepairReading } from '../ports';
import {
	REPAIR_HANDLES,
	RepairRefused,
	UNDO_HANDLES,
	type RepairExecutor,
	type RepairHandler,
	type RepairRefusal,
	type RepairRun
} from '../repair/handles';
import { repairRecordId, type RepairRecord } from '../repair/rows';
import { messageOf, StepFailed, type StepRunner } from '../step';
import { assertOperationOrg, openSite, type OpenSite } from './backup-create';
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

export interface SiteRepairInput {
	operationId: string;
	orgId: string;
	siteId: string;
	accountId: string;
	// the catalogue id; an undo names the record's own
	repairId: string;
	// an automatic run needs the switches on and spends the repair budget; an operator's does neither
	trigger: 'auto' | 'manual';
	rung: Rung;
	// the repair record this run undoes
	undoOf: string | null;
}

export interface RepairRegistries {
	catalogue: ReadonlyMap<string, CatalogueRow>;
	handles: Readonly<Record<string, RepairHandler>>;
	undo: Readonly<Record<string, RepairExecutor>>;
}

const DEFAULT_REGISTRIES: RepairRegistries = {
	catalogue: CATALOGUE,
	handles: REPAIR_HANDLES,
	undo: UNDO_HANDLES
};

export function planSiteRepair(input: Pick<SiteRepairInput, 'siteId'>): Plan {
	return buildPlan({
		type: 'site.repair',
		targetIds: [input.siteId],
		preconditions: [`${input.siteId} is active and has an owner token`],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'find', name: 'Find the site and the repair' },
			{ id: 'observe', name: 'Read the site before the repair' },
			{ id: 'check', name: 'Check the repair may run now' },
			{ id: 'repair', name: 'Run the repair' },
			{ id: 'confirm', name: 'Read the site again and check the problem cleared' }
		]
	});
}

interface Refusal {
	code: RepairRefusal;
	reason: string;
}

interface Verdict {
	refusal: Refusal | null;
}

const asJson = (value: unknown) => JSON.stringify(value);

// #region the checks

async function factsOf(
	ctx: Ctx,
	deps: RepairDeps,
	input: SiteRepairInput,
	before: RepairReading
): Promise<LadderFacts> {
	const lease =
		ctx.epoch === null
			? { ok: false }
			: await deps.leases.check(input.siteId, { holder: ctx.operationId, epoch: ctx.epoch });
	return {
		nowMs: deps.now(),
		quarantinedAt: null,
		restorePoint: undefined,
		transactionDepth: before.transactionDepth,
		// a repair call goes through the site's own router, which holds the gate for it
		gateHeld: false,
		shedding: before.shedding,
		leaseHeld: lease.ok,
		ringPromotion: await deps.ringPromotion(input.siteId)
	};
}

async function runRefusal(
	deps: RepairDeps,
	input: SiteRepairInput,
	row: CatalogueRow,
	handler: RepairHandler | undefined,
	before: RepairReading,
	facts: LadderFacts
): Promise<Refusal | null> {
	if (!handler) {
		return { code: 'no_handler', reason: `${row.repairId} needs a person (${row.automation})` };
	}
	if (!handler.verified) {
		return { code: 'no_route', reason: `the site has no owner route for ${row.handle}` };
	}
	if (input.trigger === 'auto') {
		const switches = await deps.repairs.switches(input.orgId, input.siteId);
		if (!autoRepairOn(switches)) {
			return { code: 'auto_off', reason: 'automatic repair is off for this site' };
		}
	}
	if (before.quarantined) {
		return {
			code: 'quarantined',
			reason: 'the site is quarantined until a person releases it'
		};
	}
	const blocked = blocker(row, facts);
	if (blocked !== null) return { code: 'precondition', reason: blocked };
	const past = await deps.repairs.history(
		input.orgId,
		input.siteId,
		row.repairId,
		row.attemptBound + 1
	);
	const attempts = attemptBlocker(past, row, facts.nowMs);
	if (attempts !== null) {
		return {
			code: attempts.code === 'attempts' ? 'attempts' : 'cooling_down',
			reason: attempts.reason
		};
	}
	if (input.trigger === 'auto') {
		const spent = await deps.repairs.since(facts.nowMs - HOUR_MS);
		const admitted = admitRepair(
			spent,
			{ orgId: input.orgId, nowMs: facts.nowMs },
			deps.budget
		);
		if (!admitted.admit) return { code: 'budget', reason: admitted.reason };
	}
	return null;
}

async function undoRefusal(
	row: CatalogueRow,
	record: RepairRecord,
	registries: RepairRegistries,
	facts: LadderFacts
): Promise<Refusal | null> {
	if (record.status !== 'succeeded') {
		return {
			code: 'not_undoable',
			reason: `the repair ended ${record.status}, so there is nothing to undo`
		};
	}
	if (!('handle' in row.undo)) {
		return { code: 'not_undoable', reason: row.undo.none };
	}
	if (!registries.undo[row.undo.handle]) {
		return { code: 'no_route', reason: `nothing runs ${row.undo.handle}` };
	}
	const blocked = blocker({ ...row, automation: 'auto' }, facts);
	return blocked === null ? null : { code: 'precondition', reason: blocked };
}

// #endregion

// #region steps

function readSite(
	deps: RepairDeps,
	input: SiteRepairInput,
	site: OpenSite
): Promise<RepairReading> {
	return deps.custody.withOwnerToken(input.siteId, site.ownerTokenId, (bearer) =>
		deps.repair.observe(site.hostname, { bearer })
	);
}

interface Found {
	site: OpenSite;
	row: CatalogueRow;
	record: RepairRecord | null;
}

function findStep(
	ctx: Ctx,
	deps: RepairDeps,
	input: SiteRepairInput,
	registries: RepairRegistries
): Promise<Found> {
	return runStep(ctx, 'find', 'find', async () => {
		await fenced(ctx);
		await assertOperationOrg(deps, ctx.operationId, input.orgId, 'site_not_ready');
		let record: RepairRecord | null = null;
		let repairId = input.repairId;
		if (input.undoOf !== null) {
			record = await deps.repairs.get(input.orgId, input.undoOf);
			if (record === null || record.siteId !== input.siteId) {
				throw new RepairRefused('not_undoable', `no repair ${input.undoOf} on this site`);
			}
			repairId = record.repairId;
		}
		let row: CatalogueRow;
		try {
			row = assertCatalogued(repairId, registries.catalogue);
		} catch (error) {
			if (error instanceof UncataloguedRepairError) {
				throw new RepairRefused('uncatalogued', error.message);
			}
			throw error;
		}
		const site = await openSite(
			deps,
			{ id: input.siteId, orgId: input.orgId, accountId: input.accountId },
			{ notReady: 'site_not_ready', foreign: 'site_not_ready' }
		);
		return { site, row, record };
	});
}

function checkStep(
	ctx: Ctx,
	deps: RepairDeps,
	input: SiteRepairInput,
	registries: RepairRegistries,
	found: Found,
	before: RepairReading
): Promise<Verdict> {
	return runStep(ctx, 'check', 'check', async () => {
		await fenced(ctx);
		const facts = await factsOf(ctx, deps, input, before);
		const { row, record } = found;
		const refusal =
			record === null
				? await runRefusal(
						deps,
						input,
						row,
						registries.handles[row.repairId],
						before,
						facts
					)
				: await undoRefusal(row, record, registries, facts);
		const base = {
			id: repairRecordId(input.operationId),
			organizationId: input.orgId,
			siteId: input.siteId,
			repairId: row.repairId,
			rung: input.rung,
			observationBefore: asJson({ reading: before }),
			operationId: input.operationId,
			undoOf: record?.id ?? null,
			createdAt: deps.now()
		};
		if (refusal === null) {
			await deps.repairs.begin({ ...base, status: 'running', finishedAt: null });
		} else {
			await deps.repairs.begin({
				...base,
				observationBefore: asJson({ reading: before, refused: refusal }),
				status: 'refused',
				finishedAt: deps.now()
			});
		}
		return { refusal };
	});
}

function repairStep(
	ctx: Ctx,
	deps: RepairDeps,
	input: SiteRepairInput,
	registries: RepairRegistries,
	found: Found
): Promise<RepairRun> {
	return runStep(ctx, 'repair', 'repair', async () => {
		await fenced(ctx);
		const { row, record, site } = found;
		const run =
			record === null
				? registries.handles[row.repairId]!.run
				: registries.undo[(row.undo as { handle: string }).handle]!;
		return deps.custody.withOwnerToken(input.siteId, site.ownerTokenId, (bearer) =>
			run(deps.repair, site.hostname, { bearer })
		);
	});
}

function confirmStep(
	ctx: Ctx,
	deps: RepairDeps,
	input: SiteRepairInput,
	found: Found,
	run: RepairRun
): Promise<void> {
	return runStep(ctx, 'confirm', 'confirm', async () => {
		await fenced(ctx);
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.status === 'running'
				? transition(operation, 'verifying', deps.now())
				: operation
		);
		const { row, record, site } = found;
		const after = await readSite(deps, input, site);
		const merged = { ...after, facts: { ...after.facts, ...run.facts } };
		const id = repairRecordId(input.operationId);
		let status: 'succeeded' | 'failed';
		let observation: Record<string, unknown>;
		let message = run.detail;
		if (record === null) {
			const cleared = evaluatePredicate(row.successPredicate, merged);
			status = run.ok && cleared ? 'succeeded' : 'failed';
			const past = await deps.repairs.history(
				input.orgId,
				input.siteId,
				row.repairId,
				row.attemptBound + 1
			);
			let failures = 1;
			for (const earlier of past.filter((r) => r.id !== id && r.status !== 'refused')) {
				if (earlier.status !== 'failed') break;
				failures++;
			}
			observation = {
				reading: merged,
				run: { ok: run.ok, detail: run.detail },
				predicate: { id: row.successPredicate, cleared },
				...(status === 'failed'
					? { escalation: row.escalation, escalated: failures >= row.attemptBound }
					: {})
			};
			if (status === 'failed') {
				message = run.ok
					? `${row.repairId} did not clear; ${row.escalation}`
					: `${run.detail}; ${row.escalation}`;
			}
		} else {
			status = run.ok ? 'succeeded' : 'failed';
			observation = { reading: merged, run: { ok: run.ok, detail: run.detail } };
		}
		await deps.repairs.finish(input.orgId, id, {
			status,
			observationAfter: asJson(observation),
			finishedAt: deps.now()
		});
		if (record !== null && status === 'succeeded') {
			await deps.repairs.undone(input.orgId, record.id);
		}
		await deps.store.mutate(ctx.operationId, (operation) =>
			setVerification(operation, status === 'succeeded' ? 'passed' : 'failed', deps.now())
		);
		if (status === 'failed') throw new RepairRefused('not_cleared', message);
	});
}

// #endregion

async function closeRefused(ctx: Ctx, deps: RepairDeps, refusal: Refusal): Promise<Outcome> {
	await plainStep(ctx, 'refuse', async () => {
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.status === 'cancelled'
				? operation
				: skipPending(
						observe(
							transition(operation, 'cancelled', deps.now()),
							`nothing ran: ${refusal.reason}`,
							deps.now()
						),
						deps.now()
					)
		);
	});
	await releaseLease(ctx);
	return { status: 'cancelled', reason: refusal.reason };
}

async function fail(
	ctx: Ctx,
	deps: RepairDeps,
	input: SiteRepairInput,
	failure: StepFailed
): Promise<Outcome> {
	const reason = describeFailure(failure);
	const closed = await closeFailed(ctx, failure);
	await plainStep(ctx, 'fail.row', async () => {
		await deps.repairs.finish(input.orgId, repairRecordId(input.operationId), {
			status: 'failed',
			observationAfter: asJson({ error: messageOf(failure.reason) }),
			finishedAt: deps.now()
		});
	});
	await releaseLease(ctx);
	return closed === 'cancelled'
		? { status: 'cancelled', reason }
		: { status: 'failed', reason, leaked: [] };
}

export async function runSiteRepair(
	step: StepRunner,
	deps: RepairDeps,
	input: SiteRepairInput,
	registries: RepairRegistries = DEFAULT_REGISTRIES
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.siteId,
		accountId: input.accountId,
		purpose: 'site.repair',
		epoch: null
	};
	let found: Found;
	let ran: RepairRun;
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		found = await findStep(ctx, deps, input, registries);
		const before = await runStep(ctx, 'observe', 'observe', async () => {
			await fenced(ctx);
			return readSite(deps, input, found.site);
		});
		const verdict = await checkStep(ctx, deps, input, registries, found, before);
		if (verdict.refusal !== null) return closeRefused(ctx, deps, verdict.refusal);
		ran = await repairStep(ctx, deps, input, registries, found);
		await confirmStep(ctx, deps, input, found, ran);
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		return fail(ctx, deps, input, error);
	}
	await finishSuccess(
		ctx,
		input.undoOf === null
			? `${found.row.repairId} ran and the site shows it cleared`
			: `${found.row.repairId} was undone`
	);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}

import type { Plan } from '@contracts/operations';
import { DEFAULT_CONCURRENCY, mapFleet } from '@drupflare/workforce';
import { z } from 'zod';
import { dossierFor, type Dossier } from '../../../src/server/domain/dossier';
import {
	aggregate,
	classifySite,
	couldNotCheck,
	type EstateSite,
	type Evidence,
	type ReportRow
} from '../../../src/server/domain/estate';
import { ApiError } from '../../../src/shared/errors';
import type { PreflightResult } from '../../../src/shared/preflight';
import { ImportError } from '../import-parts';
import { buildPlan, observe, setCursor, skipPending, transition } from '../operations/state';
import type { EstateDeps } from '../ports';
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

export interface EstateAssessInput {
	operationId: string;
	orgId: string;
	assessmentId: string;
	// the most a new site accepts in one restore, which the survey dossier measures against
	ceilingBytes: number;
}

const accessSchema = z.array(z.strictObject({ server: z.string(), credentialId: z.string() }));

const REPORT_PAGE = 100;
const DID_NOT_FINISH = 'The check did not finish. Start a new assessment to check this site again.';
const RERUN = new Set(['pending', 'checking', 'could not check']);

export function planEstateAssess(input: Pick<EstateAssessInput, 'assessmentId'>): Plan {
	return buildPlan({
		type: 'estate.assess',
		targetIds: [input.assessmentId],
		preconditions: ['the inventory rows are stored'],
		steps: [
			{ id: 'intake', name: 'Read the inventory' },
			{ id: 'rows', name: 'Check each site' },
			{ id: 'report', name: 'Build the report' }
		],
		rollbackPoint: null
	});
}

function unreachable(url: string, note: string): PreflightResult {
	return {
		url,
		reachable: false,
		cms: 'unknown',
		version: null,
		versionSource: null,
		hosting: null,
		signals: [],
		verdict: 'cannot tell',
		notes: [note]
	};
}

// a refused address is a measured outcome for the row, not an error to retry
async function publicCheck(deps: EstateDeps, hostname: string): Promise<PreflightResult> {
	try {
		return await deps.preflight(hostname);
	} catch (error) {
		if (error instanceof ApiError && error.code === 'unprocessable') {
			return unreachable(hostname, error.message);
		}
		throw error;
	}
}

function parseAccess(text: string): { server: string; credentialId: string }[] {
	try {
		const parsed = accessSchema.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : [];
	} catch {
		return [];
	}
}

async function gather(
	deps: EstateDeps,
	input: EstateAssessInput,
	accessText: string,
	site: EstateSite
): Promise<Evidence> {
	const preflight = await publicCheck(deps, site.input.hostname);
	const group = parseAccess(accessText).find(
		(entry) => site.input.server !== '' && entry.server === site.input.server
	);
	const evidence: Evidence = { preflight, dossier: null, access: 'none', needsProof: null };
	if (group === undefined) return evidence;
	if (site.input.docroot === '') {
		return {
			...evidence,
			gap: 'the folder this site lives in, so the survey knows where to look'
		};
	}
	try {
		const survey = await deps.imports.withTarget(
			group.credentialId,
			input.orgId,
			site.input.docroot,
			(target) => deps.survey.run(target)
		);
		const dossier: Dossier = dossierFor(
			{ ...survey, errors: survey.errors.map(({ id }) => ({ id, detail: '' })) },
			input.ceilingBytes
		);
		return { ...evidence, dossier, access: 'ready' };
	} catch (error) {
		if (error instanceof ImportError) {
			return {
				...evidence,
				gap: `a working SSH key for ${site.input.server}, with its host key confirmed`
			};
		}
		throw error;
	}
}

async function checkRow(deps: EstateDeps, input: EstateAssessInput, number: number) {
	const { estate, now } = deps;
	const { orgId, assessmentId } = input;
	const facts = await estate.assessment(orgId, assessmentId);
	if (facts === null) throw new PermanentError('assessment_missing', 'the assessment is gone');
	if (facts.state === 'cancelled') {
		await estate.skip(orgId, assessmentId, now());
		return;
	}
	const record = await estate.row(orgId, assessmentId, number);
	if (record === null) throw new PermanentError('row_missing', `row ${number} is gone`);
	if (!RERUN.has(record.state)) return;
	await estate.begin(orgId, assessmentId, number, now());
	const site = JSON.parse(record.site) as EstateSite;
	try {
		const evidence = await gather(deps, input, facts.access, site);
		await estate.finishRow(orgId, assessmentId, number, classifySite(site, evidence), now());
	} catch {
		await estate.finishRow(
			orgId,
			assessmentId,
			number,
			couldNotCheck(site, DID_NOT_FINISH),
			now()
		);
	}
}

// pages through the stored rows; a row without a verdict reads as one that could not be checked
async function buildReport(deps: EstateDeps, input: EstateAssessInput) {
	const rows: ReportRow[] = [];
	let after = 0;
	for (;;) {
		const page = await deps.estate.page(input.orgId, input.assessmentId, after, REPORT_PAGE);
		for (const record of page) {
			const site = JSON.parse(record.site) as EstateSite;
			const verdict =
				record.verdict === null
					? couldNotCheck(site, 'No result was recorded.')
					: JSON.parse(record.verdict);
			rows.push({ site, verdict });
		}
		if (page.length < REPORT_PAGE) break;
		after = page[page.length - 1]!.number;
	}
	return aggregate(rows);
}

async function closeCancelled(ctx: Ctx): Promise<void> {
	await plainStep(ctx, 'cancel', async () => {
		await ctx.deps.store.mutate(ctx.operationId, (operation) => {
			if (operation.status === 'cancelled') return operation;
			const now = ctx.deps.now();
			return skipPending(
				observe(
					transition(operation, 'cancelled', now),
					'the assessment was cancelled',
					now
				),
				now
			);
		});
	});
}

// one workflow step per row, run six at a time; a row that fails is recorded on the row and the
// rest go on, and a later run reads each row's stored state, so finished rows are never checked again
export async function runEstateAssess(
	step: StepRunner,
	deps: EstateDeps,
	input: EstateAssessInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.assessmentId,
		accountId: '',
		purpose: 'estate.assess',
		epoch: null
	};
	try {
		await startOperation(ctx);
		const numbers = await runStep(ctx, 'intake', 'intake', async () => {
			const facts = await deps.estate.assessment(input.orgId, input.assessmentId);
			if (facts === null)
				throw new PermanentError('assessment_missing', 'the assessment is gone');
			await deps.estate.start(input.orgId, input.assessmentId, deps.now());
			return deps.estate.numbers(input.orgId, input.assessmentId);
		});
		await runStep(ctx, 'rows-begin', 'rows', async () => undefined, { finish: false });
		const result = await mapFleet(
			numbers,
			(number) => step.do(`row-${number}`, () => checkRow(deps, input, number)),
			{ concurrency: DEFAULT_CONCURRENCY }
		);
		for (const outcome of result.failed) {
			if (!(outcome.error instanceof StepFailed)) throw outcome.error;
			const number = outcome.item;
			await plainStep(ctx, `row-${number}-failed`, async () => {
				const record = await deps.estate.row(input.orgId, input.assessmentId, number);
				if (record === null || !RERUN.has(record.state)) return;
				const site = JSON.parse(record.site) as EstateSite;
				await deps.estate.finishRow(
					input.orgId,
					input.assessmentId,
					number,
					couldNotCheck(site, DID_NOT_FINISH),
					deps.now()
				);
			});
		}
		await runStep(ctx, 'rows-end', 'rows', async () => undefined, { begin: false });
		const facts = await plainStep(ctx, 'read-state', () =>
			deps.estate.assessment(input.orgId, input.assessmentId)
		);
		if (facts?.state === 'cancelled') {
			await plainStep(ctx, 'skip-rest', () =>
				deps.estate.skip(input.orgId, input.assessmentId, deps.now())
			);
			await closeCancelled(ctx);
			return { status: 'cancelled', reason: 'the assessment was cancelled' };
		}
		await runStep(ctx, 'report', 'report', async () => {
			const report = await buildReport(deps, input);
			await deps.estate.finish(
				input.orgId,
				input.assessmentId,
				report,
				'finished',
				deps.now()
			);
			await deps.store.mutate(ctx.operationId, (operation) =>
				setCursor(operation, JSON.stringify(report), deps.now())
			);
		});
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		await deps.estate
			.finish(input.orgId, input.assessmentId, null, 'failed', deps.now())
			.catch(() => undefined);
		const closed = await closeFailed(ctx, error);
		const reason = describeFailure(error);
		return closed === 'cancelled'
			? { status: 'cancelled', reason }
			: { status: 'failed', reason, leaked: [] };
	}
	await finishSuccess(ctx, 'the estate was assessed');
	return { status: 'succeeded' };
}

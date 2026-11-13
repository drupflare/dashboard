import type { Plan } from '@contracts/operations';
import { dossierFor } from '../../../src/server/domain/dossier';
import type { SurveyCursor } from '../import-parts';
import { buildPlan, setCursor } from '../operations/state';
import type { ImportDeps } from '../ports';
import { StepFailed, type StepRunner } from '../step';
import {
	closeFailed,
	describeFailure,
	finishSuccess,
	runStep,
	startOperation,
	type Ctx,
	type Outcome
} from './common';

export interface ImportSurveyInput {
	operationId: string;
	orgId: string;
	credentialId: string;
	root: string;
	// the most a new site accepts in one restore
	ceilingBytes: number;
	filesLandable: boolean;
}

export function planImportSurvey(input: Pick<ImportSurveyInput, 'credentialId'>): Plan {
	return buildPlan({
		type: 'import.survey',
		targetIds: [input.credentialId],
		preconditions: ['the server host key was confirmed by the owner'],
		steps: [{ id: 'survey', name: 'Survey the server' }],
		rollbackPoint: null
	});
}

// the survey only reads, so a failure closes the operation and there is nothing to undo; the
// result is the dossier, left in the operation's cursor for the dashboard to read
export async function runImportSurvey(
	step: StepRunner,
	deps: ImportDeps,
	input: ImportSurveyInput
): Promise<Outcome> {
	// no site is involved, so the credential stands in where a site id would be
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.credentialId,
		accountId: '',
		purpose: 'import.survey',
		epoch: null
	};
	try {
		await startOperation(ctx);
		await runStep(ctx, 'survey', 'survey', async () => {
			const survey = await deps.imports.withTarget(
				input.credentialId,
				input.orgId,
				input.root,
				(target) => deps.survey.run(target)
			);
			const record: SurveyCursor = {
				v: 1,
				host: survey.host,
				root: survey.root,
				capturedAt: survey.capturedAt,
				dossier: dossierFor(
					{ ...survey, errors: survey.errors.map(({ id }) => ({ id, detail: '' })) },
					input.ceilingBytes,
					{ filesLandable: input.filesLandable }
				)
			};
			await deps.store.mutate(ctx.operationId, (operation) =>
				setCursor(operation, JSON.stringify(record), deps.now())
			);
		});
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		const closed = await closeFailed(ctx, error);
		const reason = describeFailure(error);
		return closed === 'cancelled'
			? { status: 'cancelled', reason }
			: { status: 'failed', reason, leaked: [] };
	}
	await finishSuccess(ctx, 'the server was surveyed');
	return { status: 'succeeded' };
}

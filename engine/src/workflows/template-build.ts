import type { TemplateBuildDeps } from '../ports';
import { PermanentError, StepFailed, messageOf, type StepRunner } from '../step';
import { TemplateBundleError, parseBundle, templateKeys } from '../template-bundle';
import type { Outcome } from './common';

export interface TemplateBuildInput {
	buildId: string;
	entryId: string;
	commit: string;
	// the job spec the dashboard built from its entry table
	spec: Record<string, unknown>;
}

const encoder = new TextEncoder();

// a build that did not finish leaves no ready row and no bundle in the bucket
export async function runTemplateBuild(
	step: StepRunner,
	deps: TemplateBuildDeps,
	input: TemplateBuildInput
): Promise<Outcome> {
	const key = templateKeys.build(input.entryId, input.buildId);
	try {
		await step.do('run-job', async () => {
			const answer = await deps.jobs.run({
				key,
				input: encoder.encode(JSON.stringify(input.spec))
			});
			if ('refused' in answer) {
				// a busy runner clears when the other job ends, so only that refusal retries
				if (answer.refused === 'busy') throw new Error(answer.message);
				throw new PermanentError(answer.refused, answer.message);
			}
			if (answer.state !== 'succeeded') {
				const tail = answer.logTail === null ? '' : `: ${answer.logTail}`;
				throw new PermanentError(`job_${answer.state}`, `${answer.message}${tail}`);
			}
			return { wallMs: answer.wallMs, bytesOut: answer.bytesOut };
		});
		const manifest = await step.do('check', async () => {
			const bytes = await deps.blobs.get(key);
			if (bytes === null)
				throw new PermanentError('bundle_missing', 'the job stored no bundle');
			let bundle;
			try {
				bundle = await parseBundle(bytes);
			} catch (error) {
				if (error instanceof TemplateBundleError) {
					throw new PermanentError(error.code, error.message);
				}
				throw error;
			}
			if (
				bundle.manifest.entryId !== input.entryId ||
				bundle.manifest.commit !== input.commit
			) {
				throw new PermanentError(
					'bundle_wrong_entry',
					'the bundle is for another template or commit'
				);
			}
			try {
				bundle.section('database.sql');
				bundle.section('composer.lock');
			} catch (error) {
				if (error instanceof TemplateBundleError) {
					throw new PermanentError(error.code, error.message);
				}
				throw error;
			}
			return JSON.stringify(bundle.manifest);
		});
		await step.do('record', async () => {
			await deps.templates.ready(input.buildId, { bundleKey: key, manifest });
		});
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		const reason = messageOf(error.reason);
		await step.do('discard', async () => {
			await deps.blobs.deletePrefix(key);
			await deps.templates.fail(input.buildId, reason);
		});
		return { status: 'failed', reason, leaked: [] };
	}
	return { status: 'succeeded' };
}

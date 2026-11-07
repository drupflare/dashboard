import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { buildBackupDeps, buildDeps, type EngineEnv } from '../env';
import { PermanentError, StepFailed, type StepRunner } from '../step';
import { runBackupCreate, type BackupCreateInput } from './backup-create';
import { runBackupRestore, type BackupRestoreInput } from './backup-restore';
import type { Outcome } from './common';
import { runSiteCreate, type SiteCreateInput } from './site-create';
import {
	runSiteDelete,
	runSitePurge,
	type SiteDeleteInput,
	type SitePurgeInput
} from './site-delete';
import { runSiteUpgrade, type SiteUpgradeInput } from './site-upgrade';

// retry counts and timeouts are unmeasured starting points
const STEP_CONFIG = {
	retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
	timeout: '5 minutes'
} as const;

// a restore waits on the site inside one step, so its steps may run longer; also unmeasured
const BACKUP_STEP_CONFIG = { ...STEP_CONFIG, timeout: '10 minutes' } as const;

// a permanent refusal skips the retries; whatever escapes after the retries reaches the body as StepFailed
function runnerOf(
	step: WorkflowStep,
	config: typeof STEP_CONFIG | typeof BACKUP_STEP_CONFIG = STEP_CONFIG
): StepRunner {
	return {
		async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
			try {
				return (await step.do(name, config, async () => {
					try {
						return (await fn()) as never;
					} catch (error) {
						if (error instanceof PermanentError)
							throw new NonRetryableError(error.message, error.code);
						throw error;
					}
				})) as T;
			} catch (error) {
				throw new StepFailed(name, error);
			}
		}
	};
}

export class SiteCreate extends WorkflowEntrypoint<EngineEnv, SiteCreateInput> {
	async run(
		event: Readonly<WorkflowEvent<SiteCreateInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runSiteCreate(runnerOf(step), await buildDeps(this.env), event.payload);
	}
}

export class SiteUpgrade extends WorkflowEntrypoint<EngineEnv, SiteUpgradeInput> {
	async run(
		event: Readonly<WorkflowEvent<SiteUpgradeInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runSiteUpgrade(runnerOf(step), await buildDeps(this.env), event.payload);
	}
}

export class SiteDelete extends WorkflowEntrypoint<EngineEnv, SiteDeleteInput> {
	async run(
		event: Readonly<WorkflowEvent<SiteDeleteInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runSiteDelete(runnerOf(step), await buildDeps(this.env), event.payload);
	}
}

export class BackupCreate extends WorkflowEntrypoint<EngineEnv, BackupCreateInput> {
	async run(
		event: Readonly<WorkflowEvent<BackupCreateInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runBackupCreate(
			runnerOf(step, BACKUP_STEP_CONFIG),
			await buildBackupDeps(this.env),
			event.payload
		);
	}
}

export class BackupRestore extends WorkflowEntrypoint<EngineEnv, BackupRestoreInput> {
	async run(
		event: Readonly<WorkflowEvent<BackupRestoreInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runBackupRestore(
			runnerOf(step, BACKUP_STEP_CONFIG),
			await buildBackupDeps(this.env),
			event.payload
		);
	}
}

export class SitePurge extends WorkflowEntrypoint<EngineEnv, SitePurgeInput> {
	async run(
		event: Readonly<WorkflowEvent<SitePurgeInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runSitePurge(runnerOf(step), await buildDeps(this.env), event.payload);
	}
}

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import {
	buildAccessDeps,
	buildBackupDeps,
	buildConfigDeps,
	buildCopyDeps,
	buildCutoverDeps,
	buildDeps,
	buildDomainDeps,
	buildEstateDeps,
	buildGitDeps,
	buildImportDeps,
	buildModifyDeps,
	buildModuleDeps,
	buildNodeSiteDeps,
	buildPitrDeps,
	buildRepairDeps,
	buildRollbackDeps,
	buildRolloutDeps,
	buildTemplateBuildDeps,
	selfManagedDeps,
	type EngineEnv
} from '../env';
import type { EngineDeps } from '../ports';
import { PermanentError, StepFailed, type StepRunner } from '../step';
import { runAccessSync, type AccessSyncInput } from './access-sync';
import { runBackupCreate, type BackupCreateInput } from './backup-create';
import { runBackupRestore, type BackupRestoreInput } from './backup-restore';
import { runBackupVerify } from './backup-verify';
import type { Outcome } from './common';
import { runConfigApply, type ConfigApplyInput } from './config-apply';
import { runDomainAttach, type DomainAttachInput, type DomainRunner } from './domain-attach';
import { runEnvCreate, type EnvCreateInput } from './env-create';
import { runEnvDelete, type EnvDeleteInput } from './env-delete';
import { runEstateAssess, type EstateAssessInput } from './estate-assess';
import { runGitPull, type GitPullInput } from './git-pull';
import { runImportSurvey, type ImportSurveyInput } from './import-survey';
import {
	runMigrationCutover,
	type CutoverRunner,
	type MigrationCutoverInput
} from './migration-cutover';
import { runModifyApply, type ModifyApplyInput } from './modify-apply';
import { runModuleEnable, type ModuleEnableInput } from './module-enable';
import { runModuleInstall, type ModuleInstallInput } from './module-install';
import { runModuleRemove, type ModuleRemoveInput } from './module-remove';
import { runNodeSiteCreate, type NodeRunner, type NodeSiteCreateInput } from './node-site-create';
import { runReleaseRing, type ReleaseRingInput, type RingRunner } from './release-ring';
import type { CopyInput } from './restored-copy';
import { runSiteAdopt, type SiteAdoptInput } from './site-adopt';
import { runSiteCleanup, type SiteCleanupInput } from './site-cleanup';
import { runSiteCreate, type SiteCreateInput } from './site-create';
import {
	runSiteDelete,
	runSitePurge,
	type SiteDeleteInput,
	type SitePurgeInput
} from './site-delete';
import { runSiteImport, type SiteImportInput } from './site-import';
import { runSitePitr, type SitePitrInput } from './site-pitr';
import { runSiteRepair, type SiteRepairInput } from './site-repair';
import { runSiteRollback, type SiteRollbackInput } from './site-rollback';
import { runSiteUpgrade, type SiteUpgradeInput } from './site-upgrade';
import { runTemplateBuild, type TemplateBuildInput } from './template-build';
import { runThemeDefault, type ThemeDefaultInput } from './theme-default';

// retry counts and timeouts are unmeasured starting points
const STEP_CONFIG = {
	retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
	timeout: '5 minutes'
} as const;

// a restore waits on the site inside one step, so its steps may run longer; also unmeasured
const BACKUP_STEP_CONFIG = { ...STEP_CONFIG, timeout: '10 minutes' } as const;

// the dump streams over one channel inside one step, which Cloudflare advises keeping to 30 minutes
// at most; one retry, since each retry streams the whole dump again from the owner's server
const IMPORT_STEP_CONFIG = {
	retries: { limit: 1, delay: '10 seconds', backoff: 'exponential' },
	timeout: '30 minutes'
} as const;

// a permanent refusal skips the retries; whatever escapes after the retries reaches the body as StepFailed
function runnerOf(
	step: WorkflowStep,
	config:
		| typeof STEP_CONFIG
		| typeof BACKUP_STEP_CONFIG
		| typeof IMPORT_STEP_CONFIG
		| typeof TEMPLATE_STEP_CONFIG = STEP_CONFIG
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

// a site on a customer's account runs against that account, never against ours
function onPlane<D extends EngineDeps>(
	env: EngineEnv,
	deps: D,
	site: { id: string; accountId: string; plane?: string }
): D {
	return site.plane === 'self-managed'
		? selfManagedDeps(env, deps, { siteId: site.id, accountId: site.accountId })
		: deps;
}

export class SiteCreate extends WorkflowEntrypoint<EngineEnv, SiteCreateInput> {
	async run(
		event: Readonly<WorkflowEvent<SiteCreateInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		const { site } = event.payload;
		return runSiteCreate(
			runnerOf(step),
			onPlane(this.env, await buildBackupDeps(this.env), site),
			event.payload
		);
	}
}

export class SiteUpgrade extends WorkflowEntrypoint<EngineEnv, SiteUpgradeInput> {
	async run(
		event: Readonly<WorkflowEvent<SiteUpgradeInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		const { site } = event.payload;
		return runSiteUpgrade(
			runnerOf(step),
			onPlane(this.env, await buildDeps(this.env), site),
			event.payload
		);
	}
}

export class SiteDelete extends WorkflowEntrypoint<EngineEnv, SiteDeleteInput> {
	async run(
		event: Readonly<WorkflowEvent<SiteDeleteInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runSiteDelete(runnerOf(step), await buildDomainDeps(this.env), event.payload);
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

export class ModuleInstall extends WorkflowEntrypoint<EngineEnv, ModuleInstallInput> {
	async run(
		event: Readonly<WorkflowEvent<ModuleInstallInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runModuleInstall(
			runnerOf(step, BACKUP_STEP_CONFIG),
			await buildModuleDeps(this.env),
			event.payload
		);
	}
}

export class ModuleEnable extends WorkflowEntrypoint<EngineEnv, ModuleEnableInput> {
	async run(
		event: Readonly<WorkflowEvent<ModuleEnableInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runModuleEnable(
			runnerOf(step, BACKUP_STEP_CONFIG),
			await buildModuleDeps(this.env),
			event.payload
		);
	}
}

export class ModifyApply extends WorkflowEntrypoint<EngineEnv, ModifyApplyInput> {
	async run(
		event: Readonly<WorkflowEvent<ModifyApplyInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runModifyApply(
			runnerOf(step, BACKUP_STEP_CONFIG),
			await buildModifyDeps(this.env),
			event.payload
		);
	}
}

export class ModuleRemove extends WorkflowEntrypoint<EngineEnv, ModuleRemoveInput> {
	async run(
		event: Readonly<WorkflowEvent<ModuleRemoveInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runModuleRemove(
			runnerOf(step, BACKUP_STEP_CONFIG),
			await buildModuleDeps(this.env),
			event.payload
		);
	}
}

export class ThemeDefault extends WorkflowEntrypoint<EngineEnv, ThemeDefaultInput> {
	async run(
		event: Readonly<WorkflowEvent<ThemeDefaultInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runThemeDefault(
			runnerOf(step, BACKUP_STEP_CONFIG),
			await buildModuleDeps(this.env),
			event.payload
		);
	}
}

export class BackupVerify extends WorkflowEntrypoint<EngineEnv, CopyInput> {
	async run(event: Readonly<WorkflowEvent<CopyInput>>, step: WorkflowStep): Promise<Outcome> {
		return runBackupVerify(
			runnerOf(step, BACKUP_STEP_CONFIG),
			await buildCopyDeps(this.env),
			event.payload
		);
	}
}

export class AccessSync extends WorkflowEntrypoint<EngineEnv, AccessSyncInput> {
	async run(
		event: Readonly<WorkflowEvent<AccessSyncInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runAccessSync(runnerOf(step), await buildAccessDeps(this.env), event.payload);
	}
}

export class EnvCreate extends WorkflowEntrypoint<EngineEnv, EnvCreateInput> {
	async run(
		event: Readonly<WorkflowEvent<EnvCreateInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runEnvCreate(
			runnerOf(step, BACKUP_STEP_CONFIG),
			await buildCopyDeps(this.env),
			event.payload
		);
	}
}

export class EnvDelete extends WorkflowEntrypoint<EngineEnv, EnvDeleteInput> {
	async run(
		event: Readonly<WorkflowEvent<EnvDeleteInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runEnvDelete(runnerOf(step), await buildCopyDeps(this.env), event.payload);
	}
}

export class ConfigApply extends WorkflowEntrypoint<EngineEnv, ConfigApplyInput> {
	async run(
		event: Readonly<WorkflowEvent<ConfigApplyInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runConfigApply(runnerOf(step), await buildConfigDeps(this.env), event.payload);
	}
}

export class SitePitr extends WorkflowEntrypoint<EngineEnv, SitePitrInput> {
	async run(event: Readonly<WorkflowEvent<SitePitrInput>>, step: WorkflowStep): Promise<Outcome> {
		return runSitePitr(runnerOf(step), await buildPitrDeps(this.env), event.payload);
	}
}

export class SiteAdopt extends WorkflowEntrypoint<EngineEnv, SiteAdoptInput> {
	async run(
		event: Readonly<WorkflowEvent<SiteAdoptInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runSiteAdopt(
			runnerOf(step, BACKUP_STEP_CONFIG),
			await buildBackupDeps(this.env),
			event.payload
		);
	}
}

export class SiteImport extends WorkflowEntrypoint<EngineEnv, SiteImportInput> {
	async run(
		event: Readonly<WorkflowEvent<SiteImportInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runSiteImport(
			runnerOf(step, IMPORT_STEP_CONFIG),
			await buildImportDeps(this.env),
			event.payload
		);
	}
}

export class ImportSurvey extends WorkflowEntrypoint<EngineEnv, ImportSurveyInput> {
	async run(
		event: Readonly<WorkflowEvent<ImportSurveyInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runImportSurvey(runnerOf(step), await buildImportDeps(this.env), event.payload);
	}
}

// a wait that ran out ends as a timeout error from the platform; the page does not name its class,
// so any error from the wait itself reads as the time running out
function cutoverRunnerOf(step: WorkflowStep): CutoverRunner {
	return {
		...runnerOf(step, BACKUP_STEP_CONFIG),
		async wait(name, type, timeoutMs) {
			try {
				const event = await step.waitForEvent(name, {
					type,
					timeout: `${Math.max(1, Math.ceil(timeoutMs / 1000))} seconds`
				});
				return { payload: event.payload };
			} catch {
				return null;
			}
		}
	};
}

export class MigrationCutover extends WorkflowEntrypoint<EngineEnv, MigrationCutoverInput> {
	async run(
		event: Readonly<WorkflowEvent<MigrationCutoverInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runMigrationCutover(
			cutoverRunnerOf(step),
			await buildCutoverDeps(this.env),
			event.payload
		);
	}
}

export class EstateAssess extends WorkflowEntrypoint<EngineEnv, EstateAssessInput> {
	async run(
		event: Readonly<WorkflowEvent<EstateAssessInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runEstateAssess(runnerOf(step), await buildEstateDeps(this.env), event.payload);
	}
}

export class GitPull extends WorkflowEntrypoint<EngineEnv, GitPullInput> {
	async run(event: Readonly<WorkflowEvent<GitPullInput>>, step: WorkflowStep): Promise<Outcome> {
		return runGitPull(runnerOf(step), await buildGitDeps(this.env), event.payload);
	}
}

function domainRunnerOf(step: WorkflowStep): DomainRunner {
	return {
		...runnerOf(step),
		sleep: (name, ms) => step.sleep(name, ms)
	};
}

export class DomainAttach extends WorkflowEntrypoint<EngineEnv, DomainAttachInput> {
	async run(
		event: Readonly<WorkflowEvent<DomainAttachInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runDomainAttach(
			domainRunnerOf(step),
			await buildDomainDeps(this.env),
			event.payload
		);
	}
}

function nodeRunnerOf(step: WorkflowStep): NodeRunner {
	return {
		...runnerOf(step),
		sleep: (name, ms) => step.sleep(name, ms)
	};
}

export class NodeSiteCreate extends WorkflowEntrypoint<EngineEnv, NodeSiteCreateInput> {
	async run(
		event: Readonly<WorkflowEvent<NodeSiteCreateInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runNodeSiteCreate(
			nodeRunnerOf(step),
			await buildNodeSiteDeps(this.env),
			event.payload
		);
	}
}

export class SiteCleanup extends WorkflowEntrypoint<EngineEnv, SiteCleanupInput> {
	async run(
		event: Readonly<WorkflowEvent<SiteCleanupInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		const { siteId, accountId, plane } = event.payload;
		return runSiteCleanup(
			runnerOf(step),
			onPlane(this.env, await buildDeps(this.env), { id: siteId, accountId, plane }),
			event.payload
		);
	}
}

export class SitePurge extends WorkflowEntrypoint<EngineEnv, SitePurgeInput> {
	async run(
		event: Readonly<WorkflowEvent<SitePurgeInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		const { siteId, accountId, plane } = event.payload;
		// no plane is the strict reading: a customer's account
		const deps = await buildDomainDeps(this.env);
		return runSitePurge(
			runnerOf(step),
			onPlane(this.env, deps, { id: siteId, accountId, plane: plane ?? 'self-managed' }),
			event.payload
		);
	}
}

export class SiteRepair extends WorkflowEntrypoint<EngineEnv, SiteRepairInput> {
	async run(
		event: Readonly<WorkflowEvent<SiteRepairInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runSiteRepair(runnerOf(step), await buildRepairDeps(this.env), event.payload);
	}
}

export class SiteRollback extends WorkflowEntrypoint<EngineEnv, SiteRollbackInput> {
	async run(
		event: Readonly<WorkflowEvent<SiteRollbackInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		const { site } = event.payload;
		return runSiteRollback(
			runnerOf(step),
			onPlane(this.env, await buildRollbackDeps(this.env), site),
			event.payload
		);
	}
}

function ringRunnerOf(step: WorkflowStep): RingRunner {
	return {
		...runnerOf(step),
		sleep: (name, ms) => step.sleep(name, ms)
	};
}

export class ReleaseRing extends WorkflowEntrypoint<EngineEnv, ReleaseRingInput> {
	async run(
		event: Readonly<WorkflowEvent<ReleaseRingInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runReleaseRing(ringRunnerOf(step), await buildRolloutDeps(this.env), event.payload);
	}
}

// the build runs inside the container; the workflow only waits on the runner and checks the result
const TEMPLATE_STEP_CONFIG = {
	retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' },
	timeout: '40 minutes'
} as const;

export class TemplateBuild extends WorkflowEntrypoint<EngineEnv, TemplateBuildInput> {
	async run(
		event: Readonly<WorkflowEvent<TemplateBuildInput>>,
		step: WorkflowStep
	): Promise<Outcome> {
		return runTemplateBuild(
			runnerOf(step, TEMPLATE_STEP_CONFIG),
			buildTemplateBuildDeps(this.env),
			event.payload
		);
	}
}

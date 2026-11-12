import { buildDeps, type EngineEnv } from './env';
import { handleStart } from './start';
import { sweepAndLog } from './sweep';

export { SiteLease } from './site-lease';
export {
	BackupCreate,
	BackupRestore,
	SiteAdopt,
	SiteCleanup,
	SiteCreate,
	SiteDelete,
	SitePurge,
	SiteUpgrade
} from './workflows/classes';

export default {
	fetch: (request, env) =>
		handleStart(request, {
			secret: env.START_SECRET,
			now: Date.now(),
			workflows: {
				'site-create': env.SITE_CREATE,
				'site-upgrade': env.SITE_UPGRADE,
				'site-delete': env.SITE_DELETE,
				'site-purge': env.SITE_PURGE,
				'site-cleanup': env.SITE_CLEANUP,
				'site-adopt': env.SITE_ADOPT,
				'backup-create': env.BACKUP_CREATE,
				'backup-restore': env.BACKUP_RESTORE
			}
		}),
	scheduled: (_controller, env, ctx) => {
		ctx.waitUntil(
			buildDeps(env).then((deps) => sweepAndLog(deps, { accountId: env.CF_ACCOUNT_ID }))
		);
	}
} satisfies ExportedHandler<EngineEnv>;

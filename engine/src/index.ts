import { buildDeps, type EngineEnv } from './env';
import { handleStart } from './start';
import { sweepAndLog } from './sweep';

export { SiteLease } from './site-lease';
export {
	BackupCreate,
	BackupRestore,
	SiteCreate,
	SiteDelete,
	SitePurge
} from './workflows/classes';

export default {
	fetch: (request, env) =>
		handleStart(request, {
			secret: env.START_SECRET,
			now: Date.now(),
			workflows: {
				'site-create': env.SITE_CREATE,
				'site-delete': env.SITE_DELETE,
				'site-purge': env.SITE_PURGE,
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

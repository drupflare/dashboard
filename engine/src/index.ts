import type { EngineEnv } from './env';
import { handleStart } from './start';

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
		})
} satisfies ExportedHandler<EngineEnv>;

import { buildDeps, type EngineEnv } from './env';
import { handleLink, linkNodeId } from './node-link';
import { D1NodeStore } from './node-store';
import { handleStart } from './start';
import { sweepAndLog } from './sweep';

export { NodeSession } from './node-session';
export { SiteLease } from './site-lease';
export {
	BackupCreate,
	BackupRestore,
	DomainAttach,
	GitPull,
	ImportSurvey,
	MigrationCutover,
	SiteAdopt,
	SiteCleanup,
	SiteCreate,
	SiteDelete,
	SiteImport,
	SitePurge,
	SiteUpgrade
} from './workflows/classes';

export default {
	fetch: (request, env) =>
		linkNodeId(new URL(request.url)) !== null
			? handleLink(request, {
					nodes: new D1NodeStore(env.DB),
					sessions: {
						get: (nodeId) => env.NODE_SESSION.get(env.NODE_SESSION.idFromName(nodeId))
					}
				})
			: handleStart(request, {
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
						'backup-restore': env.BACKUP_RESTORE,
						'migration-cutover': env.MIGRATION_CUTOVER,
						'site-import': env.SITE_IMPORT,
						'import-survey': env.IMPORT_SURVEY,
						'git-pull': env.GIT_PULL,
						'domain-attach': env.DOMAIN_ATTACH
					}
				}),
	scheduled: (_controller, env, ctx) => {
		ctx.waitUntil(
			buildDeps(env).then((deps) => sweepAndLog(deps, { accountId: env.CF_ACCOUNT_ID }))
		);
	}
} satisfies ExportedHandler<EngineEnv>;

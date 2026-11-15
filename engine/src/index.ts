import { isBoxArchivePath, serveBoxArchive } from './box-archive';
import { buildDeps, type EngineEnv } from './env';
import { handleLink, linkNodeId } from './node-link';
import { D1NodeStore } from './node-store';
import { handleStart } from './start';
import { sweepAndLog } from './sweep';

export { JobRunner } from './containers/job-runner';
export { NodeSession } from './node-session';
export { SiteLease } from './site-lease';
export {
	AccessSync,
	BackupCreate,
	BackupRestore,
	BackupVerify,
	ConfigApply,
	DomainAttach,
	EnvCreate,
	EnvDelete,
	EstateAssess,
	GitPull,
	ImportSurvey,
	MigrationCutover,
	ModuleEnable,
	ModuleInstall,
	ModuleRemove,
	NodeSiteCreate,
	ReleaseRing,
	SiteAdopt,
	SiteCleanup,
	SiteCreate,
	SiteDelete,
	SiteImport,
	SitePitr,
	SitePurge,
	SiteRepair,
	SiteRollback,
	SiteUpgrade,
	TemplateBuild,
	ThemeDefault
} from './workflows/classes';

export default {
	fetch: (request, env) => {
		const url = new URL(request.url);
		if (isBoxArchivePath(url)) return serveBoxArchive(request, env.BLOB);
		return linkNodeId(url) !== null
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
						'site-repair': env.SITE_REPAIR,
						'backup-create': env.BACKUP_CREATE,
						'backup-restore': env.BACKUP_RESTORE,
						'backup-verify': env.BACKUP_VERIFY,
						'access-sync': env.ACCESS_SYNC,
						'env-create': env.ENV_CREATE,
						'env-delete': env.ENV_DELETE,
						'site-pitr': env.SITE_PITR,
						'config-apply': env.CONFIG_APPLY,
						'module-install': env.MODULE_INSTALL,
						'module-enable': env.MODULE_ENABLE,
						'module-remove': env.MODULE_REMOVE,
						'theme-default': env.THEME_DEFAULT,
						'migration-cutover': env.MIGRATION_CUTOVER,
						'site-import': env.SITE_IMPORT,
						'import-survey': env.IMPORT_SURVEY,
						'estate-assess': env.ESTATE_ASSESS,
						'git-pull': env.GIT_PULL,
						'domain-attach': env.DOMAIN_ATTACH,
						'node-site-create': env.NODE_SITE_CREATE,
						'site-rollback': env.SITE_ROLLBACK,
						'release-ring': env.RELEASE_RING,
						'template-build': env.TEMPLATE_BUILD
					}
				});
	},
	scheduled: (_controller, env, ctx) => {
		ctx.waitUntil(
			buildDeps(env).then((deps) => sweepAndLog(deps, { accountId: env.CF_ACCOUNT_ID }))
		);
	}
} satisfies ExportedHandler<EngineEnv>;

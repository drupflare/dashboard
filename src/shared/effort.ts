export type EffortState = 'one-button' | 'partial' | 'blocked';

export const EFFORT_STATES: readonly EffortState[] = ['one-button', 'partial', 'blocked'];

export interface EffortRow {
	id: string;
	task: string;
	mustKnowToday: string[];
	screens: number;
	// a Worker route, or the dashboard API route where no Worker route was traced
	workerRoute: string;
	dashboardOperation: string;
	state: EffortState;
	// a worker request number from contracts/worker-requests.md; set only when blocked
	blockedBy: number | null;
	leftAfter: string;
	scheduled: string;
}

export const EFFORT: readonly EffortRow[] = [
	{
		id: 'create-site',
		task: 'Create a site',
		mustKnowToday: [
			'Choosing the site name, which becomes its public address',
			'Saving the admin password, which the screen shows once'
		],
		screens: 4,
		workerRoute: 'POST /api/v1/orgs/{orgId}/sites',
		dashboardOperation: 'site.create',
		state: 'partial',
		blockedBy: null,
		leftAfter: 'Choosing the name, and saving the admin password the screen shows once.',
		scheduled: 'Sites'
	},
	{
		id: 'delete-site',
		task: 'Delete a site',
		mustKnowToday: [
			'The primary site, and a sole claimed site, are refused until another site is made primary',
			'The wipe is final, and the dashboard holds the address for 90 days',
			'Backups are kept after a delete'
		],
		screens: 2,
		workerRoute: 'POST /retire',
		dashboardOperation: 'site.delete',
		state: 'partial',
		blockedBy: null,
		leftAfter:
			'Whether to export or back up the site before the wipe, and whether the delete is wanted.',
		scheduled: 'Sites'
	},
	{
		id: 'update-site-release',
		task: 'Update a site to a release',
		mustKnowToday: [
			'The order of module, theme and database updates, which the screen does not state',
			'Whether a cache rebuild runs after the update, which the screen does not state'
		],
		screens: 2,
		workerRoute: 'POST /api/v1/orgs/{orgId}/sites/{id}/upgrade',
		dashboardOperation: 'site.upgrade',
		state: 'partial',
		blockedBy: null,
		leftAfter: 'The Drupal update order and the cache rebuild, which the screen leaves out.',
		scheduled: 'Releases'
	},
	{
		id: 'back-up-site',
		task: 'Back up a site',
		mustKnowToday: [
			'The backup is a SQL file of the database',
			'The screen does not say whether uploaded files or the theme are included'
		],
		screens: 1,
		workerRoute: 'POST /api/v1/orgs/{orgId}/sites/{id}/backups',
		dashboardOperation: 'backup.create',
		state: 'one-button',
		blockedBy: null,
		leftAfter:
			'Whether the backup includes uploaded files and the theme, which the screen does not say.',
		scheduled: 'Backups'
	},
	{
		id: 'restore-backup',
		task: 'Restore a backup',
		mustKnowToday: [
			'A restore replaces the target database, and the screen does not say what happens to its files or caches',
			'A restore goes into another site only',
			'A dump above 16 MiB cannot be restored',
			'A dump leaves out hash_salt unless secrets are included',
			'Point-in-time recovery covers 30 days'
		],
		screens: 2,
		workerRoute: '/restore',
		dashboardOperation: 'backup.restore',
		state: 'partial',
		blockedBy: null,
		leftAfter: 'Choosing the backup or bookmark to restore, and checking the result.',
		scheduled: 'Backups'
	},
	{
		id: 'export-backup',
		task: 'Export a backup',
		mustKnowToday: [
			'The export is a SQL file only; files and the whole site are not included',
			'Opening the SQL file needs MySQL or SQLite tools'
		],
		screens: 1,
		workerRoute: '/export',
		dashboardOperation: 'none',
		state: 'partial',
		blockedBy: null,
		leftAfter:
			'Opening the SQL file, and getting files and the rest of the site from elsewhere.',
		scheduled: 'Backups'
	},
	{
		id: 'reveal-admin-password',
		task: 'Reveal the admin password',
		mustKnowToday: [
			'The password is shown once and is not kept, so save it at once',
			'Sites created before the dashboard recorded the password cannot reveal it'
		],
		screens: 1,
		workerRoute: 'POST /api/v1/orgs/{orgId}/sites/{id}/first-run-secret',
		dashboardOperation: 'none',
		state: 'partial',
		blockedBy: null,
		leftAfter: 'Saving the password when the screen shows it.',
		scheduled: 'Admin access'
	},
	{
		id: 'reset-admin-password',
		task: 'Reset a lost admin password',
		mustKnowToday: [
			'The site sign-in Forgot password link emails a reset link to the address recorded at create',
			'Whether that mail arrives is untested'
		],
		screens: 0,
		workerRoute: 'none',
		dashboardOperation: 'none',
		state: 'blocked',
		blockedBy: 13,
		leftAfter: 'The sign-in Forgot password flow, and the mail the site sends.',
		scheduled: 'Admin access'
	},
	{
		id: 'add-custom-domain',
		task: 'Add a custom domain',
		mustKnowToday: [
			'The drangler domain add command, and that a mapped host is an alias whose pages and cookies carry that host',
			'The Custom Domain route that the command writes',
			'The DNS record to add at the DNS provider (unverified for each provider)'
		],
		screens: 0,
		workerRoute: 'none',
		dashboardOperation: 'none',
		state: 'partial',
		blockedBy: null,
		leftAfter: 'The DNS record, which the dashboard does not show.',
		scheduled: 'Domains'
	},
	{
		id: 'change-setting',
		task: 'Change a setting',
		mustKnowToday: [
			'The layer a setting lives in: KV override, var or binding',
			'Some keys are refused by the writer (KV_OVERRIDABLE)',
			'A var change needs a new version'
		],
		screens: 1,
		workerRoute: 'PUT /settings',
		dashboardOperation: 'none',
		state: 'partial',
		blockedBy: null,
		leftAfter: 'The value to choose, and the restart or redeploy the change needs.',
		scheduled: 'Settings'
	},
	{
		id: 'install-module',
		task: 'Install a module',
		mustKnowToday: [
			'The module machine name',
			'The Drush command en, and that install and enable are separate steps',
			'Enabling a module reboots the interpreter, and a cache rebuild (cr) follows'
		],
		screens: 1,
		workerRoute: '/installable, /install, /enable',
		dashboardOperation: 'none',
		state: 'partial',
		blockedBy: null,
		leftAfter: 'Whether the core compatibility and census state of the module suit the site.',
		scheduled: 'Modules and themes'
	},
	{
		id: 'remove-module',
		task: 'Remove a module',
		mustKnowToday: [
			'Module dependencies (unverified)',
			'Uninstall runs before composer remove (unverified)',
			'Which config and data the module deletes (unverified)',
			'A cache rebuild follows (unverified)'
		],
		screens: 0,
		workerRoute: 'none',
		dashboardOperation: 'none',
		state: 'blocked',
		blockedBy: 14,
		leftAfter:
			'Whether to keep the data the module owns, and whether to take a restore point first.',
		scheduled: 'Modules and themes'
	},
	{
		id: 'install-theme',
		task: 'Install a theme',
		mustKnowToday: [
			'A theme goes through the theme installer, not the module installer',
			'The theme config key core.extension'
		],
		screens: 1,
		workerRoute: '/install, /enable',
		dashboardOperation: 'none',
		state: 'partial',
		blockedBy: null,
		leftAfter: 'Choosing the theme.',
		scheduled: 'Modules and themes'
	},
	{
		id: 'set-default-theme',
		task: 'Set the default or admin theme',
		mustKnowToday: [
			'The system.theme config keys default and admin (unverified)',
			'The cache rebuild after the change (unverified)'
		],
		screens: 0,
		workerRoute: 'none',
		dashboardOperation: 'none',
		state: 'blocked',
		blockedBy: 15,
		leftAfter: 'Choosing the theme.',
		scheduled: 'Modules and themes'
	},
	{
		id: 'rotate-owner-token',
		task: 'Rotate the owner token',
		mustKnowToday: [
			'The owner token is shown once, at claim',
			'recover-token needs write access to CONFIG_KV',
			'Edit rights on CONFIG_KV are owner-equivalent'
		],
		screens: 0,
		workerRoute: 'none',
		dashboardOperation: 'none',
		state: 'blocked',
		blockedBy: 16,
		leftAfter: 'Nothing that a rotate route would leave to decide.',
		scheduled: 'Owner token custody'
	},
	{
		id: 'pull-git-remote',
		task: 'Pull a git remote',
		mustKnowToday: [
			'The remote and the tracked branch',
			'The mount path',
			'A pull fetches one commit at depth one',
			'A failed boot rolls back'
		],
		screens: 1,
		workerRoute: '/git',
		dashboardOperation: 'none',
		state: 'partial',
		blockedBy: null,
		leftAfter: 'Approving a pull of a branch that has changed.',
		scheduled: 'Repositories'
	},
	{
		id: 'read-site-health',
		task: 'Read site health',
		mustKnowToday: [
			'What the verdict levels mean',
			'The restore progress text on the health panel, which the server writes'
		],
		screens: 1,
		workerRoute: 'GET /api/v1/orgs/{orgId}/sites/{id}/health',
		dashboardOperation: 'none',
		state: 'partial',
		blockedBy: null,
		leftAfter: 'The action that clears an owed node, which the panel does not show.',
		scheduled: 'Health'
	},
	{
		id: 'read-failure-reason',
		task: 'Read an operation failure reason',
		mustKnowToday: ['Which step failed', 'Whether that step is safe to repeat'],
		screens: 1,
		workerRoute: 'GET /api/v1/orgs/{orgId}/operations/{id}',
		dashboardOperation: 'none',
		state: 'partial',
		blockedBy: null,
		leftAfter: 'Whether the failed step is safe to repeat.',
		scheduled: 'Operations'
	},
	{
		id: 'retry-failed-operation',
		task: 'Retry a failed operation',
		mustKnowToday: [
			'Whether the failed step is safe to repeat',
			'A retry of a failed create removes the first attempt, then creates the site again under the same name with a new site id'
		],
		screens: 2,
		workerRoute: 'none',
		dashboardOperation: 'same as the failed operation',
		state: 'one-button',
		blockedBy: null,
		leftAfter: 'Checking why the first attempt failed before running it again.',
		scheduled: 'Operations'
	},
	{
		id: 'clean-up-failed-create',
		task: 'Clean up a failed create',
		mustKnowToday: [
			'A failed create can leave a half-made site that no site list shows',
			'The cleanup refuses a site that went live, and it frees the name for a new create'
		],
		screens: 1,
		workerRoute: 'none',
		dashboardOperation: 'repair.run',
		state: 'one-button',
		blockedBy: null,
		leftAfter: 'Deciding whether to start the create again, and fixing what made it fail.',
		scheduled: 'Operations'
	},
	{
		id: 'update-patch',
		task: 'Update a patch',
		mustKnowToday: [
			'The revision model: plan, blobs and commit, with content hashes and five revisions kept',
			'A refused commit stays stored and the old revision stays active',
			'Rollback returns to the previous revision'
		],
		screens: 0,
		workerRoute: '/modify',
		dashboardOperation: 'none',
		state: 'partial',
		blockedBy: null,
		leftAfter: 'Whether a patch still applies to the new core, which is a judgement.',
		scheduled: 'Repositories'
	},
	{
		id: 'update-worker-release',
		task: 'Update the worker release',
		mustKnowToday: [
			'The first merge needs --allow-unrelated-histories',
			'Conflicts in wrangler.jsonc resolve in favour of the site values',
			'A merge that changes src needs a deploy'
		],
		screens: 0,
		workerRoute: 'none',
		dashboardOperation: 'none',
		state: 'partial',
		blockedBy: null,
		leftAfter: 'Merge conflicts in wrangler.jsonc.',
		scheduled: 'Releases'
	},
	{
		id: 'reconcile-site',
		task: 'Reconcile a site after a release',
		mustKnowToday: [
			'Reconcile steps run one per alarm firing, unless something drives them',
			'A step that changes the compiled container drops it and any heap image'
		],
		screens: 1,
		workerRoute: 'POST /reconcile',
		dashboardOperation: 'none',
		state: 'partial',
		blockedBy: null,
		leftAfter: 'When to run it.',
		scheduled: 'Repair catalogue'
	}
];

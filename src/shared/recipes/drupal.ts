export const drupal = {
	id: 'drupal',
	name: 'Drupal',
	category: 'cms',
	compatibility: {
		flags: ['nodejs_compat'],
		provenance: { source: 'worker/wrangler.managed.jsonc:7' }
	},
	resources: [
		{
			kind: 'kv',
			binding: 'CONFIG_KV',
			optional: false,
			provenance: { source: 'worker/wrangler.managed.jsonc:42' }
		},
		{
			kind: 'kv',
			binding: 'PAGE_KV',
			optional: false,
			provenance: { source: 'worker/wrangler.managed.jsonc:42' }
		},
		{
			kind: 'd1',
			binding: 'FLEET_DB',
			optional: true,
			provenance: { source: 'worker/wrangler.managed.jsonc:43' }
		},
		{
			kind: 'r2',
			binding: 'FILES',
			optional: false,
			provenance: { source: 'worker/wrangler.managed.jsonc:44' }
		},
		{
			kind: 'r2',
			binding: 'FILES_PRIVATE',
			optional: false,
			provenance: { source: 'worker@f7b3b18/wrangler.managed.jsonc:47' }
		},
		{
			kind: 'send_email',
			binding: 'SEND_EMAIL',
			optional: false,
			provenance: { source: 'worker/wrangler.managed.jsonc:45' }
		}
	],
	durableObjects: [
		{
			binding: 'SITE',
			className: 'SitePhpDurableObject',
			provenance: { source: 'worker/wrangler.managed.jsonc:38' }
		},
		{
			binding: 'RENDER_LANES',
			className: 'RenderLane',
			provenance: { source: 'worker/wrangler.managed.jsonc:39' }
		}
	],
	durableMigrations: [
		{
			tag: 'v1',
			newSqliteClasses: ['SitePhpDurableObject'],
			provenance: { source: 'worker/wrangler.managed.jsonc:48' }
		},
		{
			tag: 'v2',
			newSqliteClasses: ['RenderLane'],
			provenance: { source: 'worker/wrangler.managed.jsonc:49' }
		}
	],
	crons: [
		{ schedule: '*/5 * * * *', provenance: { source: 'worker/wrangler.managed.jsonc:55' } }
	],
	versionMetadata: {
		binding: 'CF_VERSION_METADATA',
		provenance: { source: 'worker/wrangler.managed.jsonc:46' }
	},
	assets: {
		directory: './assets',
		provenance: { source: 'worker/wrangler.managed.jsonc:52' }
	},
	refused: [],
	secrets: [],
	variables: [
		{ name: 'CMS', optional: false, provenance: { source: 'worker/wrangler.managed.jsonc:9' } },
		{
			name: 'LAZY_MOUNT',
			optional: false,
			provenance: { source: 'worker/wrangler.managed.jsonc:10' }
		},
		{
			name: 'LAZY_FS_BUDGET_BYTES',
			optional: false,
			provenance: { source: 'worker/wrangler.managed.jsonc:11' }
		},
		{
			name: 'GEN_BUCKET_MS',
			optional: false,
			provenance: { source: 'worker/wrangler.managed.jsonc:12' }
		},
		{
			name: 'PLAN',
			optional: false,
			platformSet: true,
			provenance: { source: 'worker/wrangler.managed.jsonc:13' }
		},
		{
			name: 'ASSET_AGGREGATES',
			optional: false,
			provenance: { source: 'worker/wrangler.managed.jsonc:14' }
		},
		{
			name: 'SITE_ID_PORTS',
			optional: false,
			platformSet: true,
			provenance: { source: 'worker/wrangler.managed.jsonc:15' }
		},
		{
			name: 'CACHE_API',
			optional: false,
			platformSet: true,
			provenance: { source: 'worker/wrangler.managed.jsonc:16' }
		},
		{
			name: 'FILE_STORE',
			optional: false,
			platformSet: true,
			provenance: { source: 'worker@f7b3b18/wrangler.managed.jsonc:17' }
		},
		{
			name: 'SITE_ID',
			optional: false,
			platformSet: true,
			provenance: { source: 'dashboard/engine/src/descriptor.ts:183' }
		}
	],
	firstRun: {
		method: 'POST',
		path: '/firstrun',
		provenance: { source: 'worker/src/site/routes.ts:26' },
		body: [
			{
				name: 'siteName',
				value: 'owner-input',
				required: false,
				provenance: { source: 'worker/src/do/routes/lifecycle.ts:439' }
			},
			{
				name: 'adminMail',
				value: 'admin-email',
				required: false,
				provenance: { source: 'worker/src/do/routes/lifecycle.ts:442' }
			},
			{
				name: 'adminPass',
				value: 'admin-password',
				required: false,
				provenance: { source: 'worker/src/do/routes/lifecycle.ts:443' }
			}
		],
		settingKeys: [],
		success: {
			statuses: [200],
			provenance: { source: 'worker/src/do/routes/lifecycle.ts:498' }
		},
		alreadyDone: {
			status: 409,
			provenance: { source: 'worker/src/do/routes/lifecycle.ts:349' }
		},
		password: {
			minLength: null,
			maxLength: null,
			requires: [],
			generatedLength: {
				value: 24,
				provenance: { source: 'worker/src/do/routes/lifecycle.ts:435' }
			},
			delivery: 'shown-once',
			provenance: { source: 'worker/src/do/routes/lifecycle.ts:435' }
		},
		ownerToken: {
			responseField: 'ownerToken',
			delivery: 'shown-once',
			custody: {
				store: 'encrypted with encryptRecord before it is stored',
				provenance: { source: 'dashboard/src/server/services/owner-tokens.ts:138' }
			},
			provenance: { source: 'worker/src/do/routes/lifecycle.ts:497' }
		},
		admin: {
			nameField: 'adminName',
			mailField: 'adminMail',
			provenance: { source: 'worker/src/site/php/first-run-config.php:89' }
		}
	},
	probe: {
		method: 'GET',
		path: '/health',
		auth: 'owner-token',
		provenance: { source: 'worker/src/site/routes.ts:106' }
	},
	settings: [],
	release: {
		workerAsset: null,
		provenance: { source: 'worker/.github/workflows/release.yml:229' }
	}
};

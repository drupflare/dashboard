export const mylora = {
	id: 'mylora',
	name: 'MyLoRA',
	category: 'workers',
	compatibility: {
		flags: ['nodejs_compat'],
		provenance: { source: 'MyLoRA/nuxt.config.ts:126' }
	},
	resources: [
		{
			kind: 'd1',
			binding: 'DB',
			optional: false,
			migrationsDir: '.output/server/db/migrations/',
			migrationsTable: '_hub_migrations',
			provenance: { source: 'MyLoRA/wrangler.jsonc:5' }
		},
		{
			kind: 'kv',
			binding: 'KV',
			optional: false,
			provenance: { source: 'MyLoRA/wrangler.jsonc:12' }
		},
		{
			kind: 'kv',
			binding: 'CACHE',
			optional: false,
			provenance: { source: 'MyLoRA/wrangler.jsonc:15' }
		},
		{
			kind: 'r2',
			binding: 'BLOB',
			optional: false,
			provenance: { source: 'MyLoRA/wrangler.jsonc:20' }
		},
		{
			kind: 'send_email',
			binding: 'EMAIL',
			optional: true,
			provenance: { source: 'MyLoRA/wrangler.jsonc:25' }
		}
	],
	durableObjects: [
		{
			binding: '$DurableObject',
			className: '$DurableObject',
			provenance: { source: 'MyLoRA/wrangler.jsonc:37' }
		}
	],
	durableMigrations: [
		{
			tag: 'v1',
			newSqliteClasses: ['$DurableObject'],
			provenance: { source: 'MyLoRA/wrangler.jsonc:39' }
		}
	],
	crons: [{ schedule: '* * * * *', provenance: { source: 'MyLoRA/wrangler.jsonc:41' } }],
	assets: {
		directory: '.output/public',
		provenance: {
			unverified: true,
			confirm: 'the public directory of the nitro cloudflare build output; not read'
		}
	},
	refused: [
		{
			kind: 'ai',
			binding: 'AI',
			reason: 'Workers AI is not verified on a dispatch namespace.',
			provenance: { source: 'MyLoRA/wrangler.jsonc:28' }
		}
	],
	secrets: [
		{
			name: 'NUXT_SESSION_PASSWORD',
			encoding: 'base64',
			length: 64,
			required: false,
			provenance: { source: 'MyLoRA/src/server/middleware/00-session-bootstrap.ts:9' }
		},
		{
			name: 'NUXT_ENCRYPTION_KEY',
			encoding: 'base64',
			length: 64,
			required: false,
			provenance: { source: 'MyLoRA/src/server/utils/crypto.ts:46' }
		},
		{
			name: 'NUXT_ANALYTICS_SALT',
			encoding: 'hex',
			length: 64,
			required: false,
			provenance: {
				unverified: true,
				confirm:
					'the app reads the salt from nuxt.config.ts:30 but sets no length; 64 hex characters is a choice'
			}
		}
	],
	variables: [
		{
			name: 'NUXT_PUBLIC_SITE_URL',
			optional: true,
			provenance: { source: 'MyLoRA/nuxt.config.ts:57' }
		}
	],
	firstRun: {
		method: 'POST',
		path: '/api/setup/init',
		provenance: { source: 'MyLoRA/src/server/api/setup/init.post.ts:14' },
		body: [
			{
				name: 'username',
				value: 'admin-username',
				required: true,
				minLength: 3,
				maxLength: 32,
				pattern: '^[a-z0-9_-]{3,32}$',
				provenance: { source: 'MyLoRA/src/shared/schemas.ts:97' }
			},
			{
				name: 'displayName',
				value: 'owner-input',
				required: true,
				minLength: 1,
				maxLength: 50,
				provenance: { source: 'MyLoRA/src/shared/schemas.ts:168' }
			},
			{
				name: 'password',
				value: 'admin-password',
				required: true,
				provenance: { source: 'MyLoRA/src/shared/schemas.ts:172' }
			},
			{
				name: 'bio',
				value: 'owner-input',
				required: false,
				maxLength: 500,
				provenance: { source: 'MyLoRA/src/shared/schemas.ts:177' }
			}
		],
		settingKeys: [
			{
				key: 'rateLimits',
				provenance: { source: 'MyLoRA/src/server/api/setup/init.post.ts:95' }
			},
			{
				key: 'permissions',
				provenance: { source: 'MyLoRA/src/server/api/setup/init.post.ts:97' }
			},
			{ key: 'access', provenance: { source: 'MyLoRA/src/server/api/setup/init.post.ts:99' } }
		],
		success: {
			statuses: [200],
			provenance: { source: 'MyLoRA/src/server/api/setup/init.post.ts:124' }
		},
		alreadyDone: {
			status: 409,
			provenance: { source: 'MyLoRA/src/server/api/setup/init.post.ts:20' }
		},
		password: {
			minLength: 8,
			maxLength: 128,
			requires: [],
			generatedLength: {
				value: 24,
				provenance: {
					unverified: true,
					confirm:
						'the generated length is a choice; the app sets only a minimum and a maximum'
				}
			},
			delivery: 'shown-once',
			provenance: { source: 'MyLoRA/src/shared/schemas.ts:172' }
		}
	},
	probe: {
		method: 'GET',
		path: '/api/setup/status',
		provenance: { source: 'MyLoRA/src/server/api/setup/status.get.ts:9' }
	},
	settings: [
		{
			key: 'name',
			label: 'Site Name',
			access: 'read-only',
			maxLength: 50,
			provenance: { source: 'MyLoRA/src/shared/schemas.ts:262' }
		},
		{
			key: 'description',
			label: 'Description',
			access: 'read-only',
			maxLength: 160,
			provenance: { source: 'MyLoRA/src/shared/schemas.ts:263' }
		},
		{
			key: 'author',
			label: 'Author',
			access: 'read-only',
			maxLength: 50,
			provenance: { source: 'MyLoRA/src/shared/schemas.ts:264' }
		},
		{
			key: 'bio',
			label: 'Bio',
			access: 'read-only',
			maxLength: 500,
			provenance: { source: 'MyLoRA/src/shared/schemas.ts:265' }
		},
		{
			key: 'supportEmail',
			label: 'Support Email',
			access: 'read-only',
			maxLength: 255,
			format: 'email',
			provenance: { source: 'MyLoRA/src/shared/schemas.ts:280' }
		}
	],
	release: {
		workerAsset: null,
		provenance: { source: 'MyLoRA/.github/workflows/release.yml:42' }
	}
};

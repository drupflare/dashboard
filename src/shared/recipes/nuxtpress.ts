export const nuxtpress = {
	id: 'nuxtpress',
	name: 'NuxtPress',
	category: 'workers',
	compatibility: {
		flags: ['nodejs_compat'],
		provenance: { source: 'nuxtpress/nuxt.config.ts:193' }
	},
	resources: [
		{
			kind: 'd1',
			binding: 'DB',
			optional: false,
			migrationsDir: '.output/server/db/migrations/',
			migrationsTable: '_hub_migrations',
			provenance: { source: 'nuxtpress/wrangler.jsonc:5' }
		},
		{
			kind: 'kv',
			binding: 'KV',
			optional: false,
			provenance: { source: 'nuxtpress/wrangler.jsonc:12' }
		},
		{
			kind: 'kv',
			binding: 'CACHE',
			optional: false,
			provenance: { source: 'nuxtpress/wrangler.jsonc:15' }
		},
		{
			kind: 'r2',
			binding: 'BLOB',
			optional: false,
			provenance: { source: 'nuxtpress/wrangler.jsonc:20' }
		},
		{
			kind: 'send_email',
			binding: 'EMAIL',
			optional: true,
			provenance: { source: 'nuxtpress/wrangler.jsonc:25' }
		}
	],
	durableObjects: [],
	durableMigrations: [],
	crons: [
		{ schedule: '*/5 * * * *', provenance: { source: 'nuxtpress/wrangler.jsonc:29' } },
		{ schedule: '0 4 * * *', provenance: { source: 'nuxtpress/wrangler.jsonc:29' } }
	],
	assets: {
		directory: '.output/public',
		provenance: {
			unverified: true,
			confirm: 'the public directory of the nitro cloudflare build output; not read'
		}
	},
	refused: [],
	secrets: [
		{
			name: 'NUXT_SESSION_PASSWORD',
			encoding: 'base64',
			length: 64,
			required: false,
			provenance: { source: 'nuxtpress/src/server/utils/session-password.ts:9' }
		},
		{
			name: 'NUXT_ANALYTICS_SALT',
			encoding: 'hex',
			length: 64,
			required: false,
			provenance: {
				unverified: true,
				confirm:
					'the app reads the salt from nuxt.config.ts:54 but sets no length; 64 hex characters is a choice'
			}
		}
	],
	variables: [
		{
			name: 'NUXT_PUBLIC_SITE_URL',
			optional: true,
			provenance: { source: 'nuxtpress/nuxt.config.ts:70' }
		}
	],
	firstRun: {
		method: 'POST',
		path: '/api/setup/init',
		provenance: { source: 'nuxtpress/src/server/api/setup/init.post.ts:7' },
		body: [
			{
				name: 'username',
				value: 'admin-username',
				required: true,
				minLength: 3,
				maxLength: 32,
				pattern: '^[a-z0-9_-]{3,32}$',
				provenance: { source: 'nuxtpress/src/shared/schemas.ts:214' }
			},
			{
				name: 'displayName',
				value: 'owner-input',
				required: true,
				minLength: 1,
				maxLength: 50,
				provenance: { source: 'nuxtpress/src/shared/schemas.ts:222' }
			},
			{
				name: 'password',
				value: 'admin-password',
				required: true,
				provenance: { source: 'nuxtpress/src/shared/schemas.ts:226' }
			},
			{
				name: 'bio',
				value: 'owner-input',
				required: false,
				maxLength: 500,
				provenance: { source: 'nuxtpress/src/shared/schemas.ts:231' }
			}
		],
		settingKeys: [],
		success: {
			statuses: [200],
			provenance: { source: 'nuxtpress/src/server/api/setup/init.post.ts:81' }
		},
		alreadyDone: {
			status: 409,
			provenance: { source: 'nuxtpress/src/server/api/setup/init.post.ts:12' }
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
			provenance: { source: 'nuxtpress/src/shared/schemas.ts:226' }
		}
	},
	probe: {
		method: 'GET',
		path: '/api/setup/status',
		provenance: { source: 'nuxtpress/src/server/api/setup/status.get.ts:9' }
	},
	settings: [
		{
			key: 'name',
			label: 'Site Name',
			access: 'read-only',
			maxLength: 50,
			provenance: { source: 'nuxtpress/src/server/api/settings.post.ts:102' }
		},
		{
			key: 'description',
			label: 'Description',
			access: 'read-only',
			maxLength: 160,
			provenance: { source: 'nuxtpress/src/server/api/settings.post.ts:113' }
		},
		{
			key: 'author',
			label: 'Author',
			access: 'read-only',
			maxLength: 50,
			provenance: { source: 'nuxtpress/src/server/api/settings.post.ts:135' }
		},
		{
			key: 'bio',
			label: 'Bio',
			access: 'read-only',
			maxLength: 500,
			provenance: { source: 'nuxtpress/src/server/api/settings.post.ts:124' }
		}
	],
	release: {
		workerAsset: null,
		provenance: { source: 'nuxtpress/.github/workflows/release.yml:42' }
	}
};

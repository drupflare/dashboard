export const smoke = {
	id: 'smoke',
	name: 'Smoke',
	category: 'workers',
	compatibility: {
		flags: ['nodejs_compat'],
		provenance: { source: 'smoke/wrangler.jsonc:4' }
	},
	resources: [
		{
			kind: 'd1',
			binding: 'DB',
			optional: false,
			migrationsDir: '.output/server/db/migrations/',
			migrationsTable: '_hub_migrations',
			provenance: { source: 'smoke/wrangler.jsonc:11' }
		},
		{
			kind: 'd1',
			binding: 'DB_SECONDARY',
			optional: true,
			provenance: { source: 'smoke/wrangler.jsonc:17' }
		},
		{
			kind: 'd1',
			binding: 'DB_TERTIARY',
			optional: true,
			provenance: { source: 'smoke/wrangler.jsonc:23' }
		},
		{
			kind: 'kv',
			binding: 'KV',
			optional: false,
			provenance: { source: 'smoke/wrangler.jsonc:31' }
		},
		{
			kind: 'kv',
			binding: 'CACHE',
			optional: false,
			provenance: { source: 'smoke/wrangler.jsonc:35' }
		},
		{
			kind: 'r2',
			binding: 'BLOB',
			optional: false,
			provenance: { source: 'smoke/wrangler.jsonc:45' }
		}
	],
	durableObjects: [],
	durableMigrations: [],
	crons: [
		{ schedule: '*/15 * * * *', provenance: { source: 'smoke/wrangler.jsonc:7' } },
		{ schedule: '0 3 * * *', provenance: { source: 'smoke/wrangler.jsonc:7' } },
		{ schedule: '30 3 * * *', provenance: { source: 'smoke/wrangler.jsonc:7' } }
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
			name: 'MASTER_KEY',
			encoding: 'hex',
			length: 64,
			required: true,
			provenance: {
				unverified: true,
				confirm:
					'the app checks that MASTER_KEY is set (smoke/src/server/db/schema.ts:358) and sets no length; 64 hex characters is a choice'
			}
		},
		{
			name: 'HMAC_SECRET',
			encoding: 'hex',
			length: 64,
			required: true,
			provenance: { source: 'smoke/src/server/db/schema.ts:371' }
		}
	],
	variables: [
		{
			name: 'SUPPORT_EMAIL',
			optional: true,
			provenance: { source: 'smoke/src/server/utils/settings.ts:483' }
		},
		{
			name: 'NUXT_PUBLIC_SITE_URL',
			optional: true,
			provenance: { source: 'smoke/nuxt.config.ts:30' }
		}
	],
	firstRun: {
		method: 'POST',
		path: '/api/setup/init',
		provenance: { source: 'smoke/src/server/api/setup/init.post.ts:64' },
		body: [
			{
				name: 'username',
				value: 'admin-username',
				required: true,
				minLength: 3,
				maxLength: 64,
				pattern: '^[a-zA-Z0-9_$%~.<>]+$',
				provenance: { source: 'smoke/src/shared/utils/schemas.ts:73' }
			},
			{
				name: 'email',
				value: 'admin-email',
				required: true,
				format: 'email',
				maxLength: 128,
				provenance: { source: 'smoke/src/shared/utils/schemas.ts:79' }
			},
			{
				name: 'password',
				value: 'admin-password',
				required: true,
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:39' }
			},
			{
				name: 'adminAvatar',
				value: 'owner-input',
				required: false,
				maxLength: 256,
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:41' }
			},
			{
				name: 'firstName',
				value: 'owner-input',
				required: false,
				maxLength: 64,
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:42' }
			},
			{
				name: 'lastName',
				value: 'owner-input',
				required: false,
				maxLength: 64,
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:43' }
			}
		],
		settingKeys: [
			{ key: 'name', provenance: { source: 'smoke/src/server/api/setup/init.post.ts:151' } },
			{
				key: 'description',
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:151' }
			},
			{
				key: 'themeColor',
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:151' }
			},
			{
				key: 'favicon',
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:151' }
			},
			{
				key: 'faviconPng',
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:151' }
			},
			{
				key: 'website',
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:151' }
			},
			{
				key: 'supportEmail',
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:151' }
			},
			{
				key: 'github',
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:151' }
			},
			{
				key: 'twitter',
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:151' }
			},
			{
				key: 'discord',
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:151' }
			},
			{
				key: 'linkedin',
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:151' }
			},
			{
				key: 'instagram',
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:151' }
			},
			{
				key: 'patreon',
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:151' }
			},
			{
				key: 'branding',
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:150' }
			},
			{
				key: 'security',
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:77' }
			},
			{
				key: 'retention',
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:157' }
			},
			{
				key: 'locking',
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:157' }
			},
			{
				key: 'automation',
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:157' }
			},
			{ key: 'ai', provenance: { source: 'smoke/src/server/api/setup/init.post.ts:157' } },
			{
				key: 'role_icons',
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:157' }
			},
			{
				key: 'role_colors',
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:157' }
			},
			{
				key: 'avatars',
				provenance: { source: 'smoke/src/server/api/setup/init.post.ts:157' }
			}
		],
		success: {
			statuses: [200],
			provenance: { source: 'smoke/src/server/api/setup/init.post.ts:204' }
		},
		alreadyDone: {
			status: 409,
			provenance: { source: 'smoke/src/server/api/setup/init.post.ts:72' }
		},
		password: {
			minLength: 12,
			maxLength: 128,
			requires: ['lower', 'upper', 'digit', 'symbol'],
			generatedLength: {
				value: 24,
				provenance: {
					unverified: true,
					confirm:
						'the generated length is a choice; the app sets only the complexity rules'
				}
			},
			delivery: 'shown-once',
			provenance: { source: 'smoke/src/shared/utils/schemas.ts:222' }
		}
	},
	probe: {
		method: 'GET',
		path: '/api/setup/status',
		provenance: { source: 'smoke/src/server/api/setup/status.get.ts:6' }
	},
	settings: [],
	release: {
		workerAsset: null,
		provenance: { source: 'smoke/.github/workflows/release.yml:42' }
	}
};

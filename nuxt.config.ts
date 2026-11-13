import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { defineOrganization } from 'nuxt-schema-org/schema';
import { defineNuxtConfig } from 'nuxt/config';
export default defineNuxtConfig({
	modules: [
		'@nuxthub/core',
		'@nuxt/ui',
		'@nuxt/content',
		'@nuxt/icon',
		'@nuxt/image',
		'@pinia/nuxt',
		'@vueuse/nuxt',
		'@nuxtjs/robots',
		'@nuxtjs/sitemap',
		'@nuxtjs/turnstile',
		'nuxt-schema-org'
	],
	content: {
		experimental: { nativeSqlite: true }
	},
	runtimeConfig: {
		baseUrl: process.env.NUXT_BASE_URL || 'https://app.drupflare.com',
		public: {
			githubClientId: process.env.NUXT_PUBLIC_GITHUB_CLIENT_ID || '',
			gitlabClientId: process.env.NUXT_PUBLIC_GITLAB_CLIENT_ID || '',
			cloudflareClientId: process.env.NUXT_PUBLIC_CLOUDFLARE_CLIENT_ID || '',
			githubAppId: process.env.NUXT_PUBLIC_GITHUB_APP_ID || '',
			githubAppClientId: process.env.NUXT_PUBLIC_GITHUB_APP_CLIENT_ID || '',
			githubAppSlug: process.env.NUXT_PUBLIC_GITHUB_APP_SLUG || 'drupflare'
		},
		githubApp: {
			privateKey: '',
			clientSecret: '',
			webhookSecret: ''
		},
		turnstile: {
			secretKey: process.env.NUXT_TURNSTILE_SECRET_KEY || ''
		}
	},
	ssr: true,
	compatibilityDate: '2026-08-01',
	devtools: { enabled: process.env.NODE_ENV !== 'production' },
	alias: {
		'@contracts': fileURLToPath(new URL('./contracts/src', import.meta.url))
	},
	srcDir: 'src',
	serverDir: 'src/server',
	dir: {
		shared: 'src/shared'
	},
	css: ['~/assets/css/main.css'],
	fonts: {
		families: [
			{ name: 'IBM Plex Sans', provider: 'google', weights: [400, 500, 600] },
			{ name: 'IBM Plex Mono', provider: 'google', weights: [400, 500] },
			{ name: 'Archivo', provider: 'google', weights: [600, 700] }
		]
	},
	app: {
		head: {
			link: [
				{ rel: 'icon', href: '/favicon.ico', sizes: 'any' },
				{ rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png' },
				{ rel: 'apple-touch-icon', href: '/favicon-180.png' },
				{ rel: 'preconnect', href: 'https://drupflare.com' },
				{ rel: 'dns-prefetch', href: 'https://drupflare.com' },
				{ rel: 'preconnect', href: 'https://drupflare.app' },
				{ rel: 'dns-prefetch', href: 'https://drupflare.app' }
			]
		}
	},
	nitro: {
		preset: 'cloudflare_module',
		experimental: { tasks: true },
		moduleSideEffects: ['reflect-metadata'],
		externals: { inline: ['@drupflare/untarl'] },
		rollupConfig: {
			plugins: [
				{
					// untarl ships TypeScript source and nitro skips esbuild inside node_modules
					name: 'untarl-ts',
					async transform(code: string, id: string) {
						if (!id.includes('/@drupflare/untarl/src/')) return null;
						const { transform } = await import('esbuild');
						const out = await transform(code, {
							loader: 'ts',
							format: 'esm',
							target: 'es2022'
						});
						return { code: out.code, map: null };
					}
				}
			]
		},
		scheduledTasks: {
			'*/15 * * * *': [
				'pending-secrets-purge',
				'single-use-purge',
				'import-credentials-purge'
			]
		},
		publicAssets: [
			{
				dir: fileURLToPath(new URL('./node_modules/swagger-ui-dist', import.meta.url)),
				baseURL: '/api/swagger-ui',
				maxAge: 31536000
			}
		],
		cloudflare: {
			deployConfig: true,
			nodeCompat: true
		}
	},
	routeRules: {
		'/docs/**': { prerender: true, headers: { 'cache-control': 'public, max-age=300' } }
	},
	vite: {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		plugins: [tailwindcss() as any],
		optimizeDeps: {
			include: [
				'@vue/devtools-core',
				'@vue/devtools-kit',
				'@internationalized/date',
				'luxon',
				'zod'
			]
		},
		build: {
			reportCompressedSize: false
		}
	},
	sourcemap: {
		client: process.env.NUXT_TEST_BUILD === '1',
		server: process.env.NUXT_TEST_BUILD === '1'
	},
	hub: {
		db: 'sqlite',
		kv: true,
		blob: true,
		cache: true
	},
	colorMode: {
		preference: 'system',
		fallback: 'light'
	},
	turnstile: {
		siteKey: process.env.NUXT_PUBLIC_TURNSTILE_SITE_KEY || '',
		addValidateEndpoint: true
	},
	robots: {
		mergeWithRobotsTxtPath: false,
		disallow: ['/admin', '/oauth/', '/__test__/']
	},
	experimental: {
		renderJsonPayloads: true,
		viewTransition: true
	},
	schemaOrg: {
		identity: defineOrganization({
			name: 'Drupflare',
			logo: '/drupflare.png',
			url: 'https://drupflare.com',
			foundingDate: '2026-08-15'
		})
	}
});

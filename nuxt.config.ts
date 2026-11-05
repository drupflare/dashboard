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
		'nuxt-schema-org',
		'nuxt-api-shield'
	],
	content: {
		experimental: { nativeSqlite: true }
	},
	runtimeConfig: {
		baseUrl: process.env.NUXT_BASE_URL || 'https://app.drupflare.com',
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
	app: {
		head: {
			link: [
				{ rel: 'preconnect', href: 'https://fonts.googleapis.com' },
				{ rel: 'dns-prefetch', href: 'https://fonts.googleapis.com' },
				{ rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: 'anonymous' },
				{ rel: 'dns-prefetch', href: 'https://fonts.gstatic.com' },
				{ rel: 'preconnect', href: 'https://drupflare.com' },
				{ rel: 'dns-prefetch', href: 'https://drupflare.com' }
			]
		}
	},
	nitro: {
		preset: 'cloudflare_module',
		publicAssets: [
			{
				dir: fileURLToPath(new URL('./node_modules/swagger-ui-dist', import.meta.url)),
				baseURL: '/api/swagger-ui',
				maxAge: 31536000
			}
		],
		storage: {
			shield: { driver: 'cloudflare-kv-binding', binding: 'CACHE' }
		},
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

import type { H3Event } from 'h3';
import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime';
import { bootOnce, isBooted, type BootEnv, type BootOptions } from '../services/boot';

type RuntimeConfig = ReturnType<typeof useRuntimeConfig>;

let warned = false;

export function bootOptionsOf(config: RuntimeConfig): BootOptions {
	return {
		dev: import.meta.dev,
		baseUrl: config.baseUrl as string,
		oauthClientIds: {
			github: config.public.githubClientId as string,
			gitlab: config.public.gitlabClientId as string,
			cloudflare: config.public.cloudflareClientId as string
		},
		githubApp: {
			appId: config.public.githubAppId as string,
			clientId: config.public.githubAppClientId as string,
			slug: config.public.githubAppSlug as string,
			privateKey: config.githubApp.privateKey as string,
			clientSecret: config.githubApp.clientSecret as string,
			webhookSecret: config.githubApp.webhookSecret as string
		},
		releaseHook: { secret: config.releaseHook.secret as string }
	};
}

// a scheduled run has no request event; useRuntimeConfig only reads event.context.nitro, and a
// fresh one makes it apply the NUXT_ environment overrides the same way a request does
const scheduledEvent = () => ({ context: { nitro: {} } }) as unknown as H3Event;

export default defineNitroPlugin((nitroApp) => {
	nitroApp.hooks.hook('request', (event) => {
		const env = event.context.cloudflare?.env as BootEnv | undefined;
		if (!env) {
			if (!warned) {
				warned = true;
				console.warn('boot skipped: the request carries no cloudflare env');
			}
			return;
		}
		try {
			bootOnce(env, bootOptionsOf(useRuntimeConfig(event)));
		} catch (error) {
			console.error('boot failed; sign-in stays closed', error);
		}
	});

	// the preset queues this hook before it starts the cron tasks, so the tasks find the services
	nitroApp.hooks.hook('cloudflare:scheduled', ({ env }) => {
		if (!env) {
			console.error('boot skipped: the scheduled run carries no cloudflare env');
			return;
		}
		if (isBooted()) return;
		try {
			const config = useRuntimeConfig(scheduledEvent());
			bootOnce(env as BootEnv, bootOptionsOf(config));
			console.log('services booted by a scheduled run', { baseUrl: config.baseUrl });
		} catch (error) {
			console.error(
				'boot failed on a scheduled run; the tasks that need services skip',
				error
			);
		}
	});
});

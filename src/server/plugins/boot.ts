import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime';
import { bootOnce, type BootEnv } from '../services/boot';

let warned = false;

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
			const config = useRuntimeConfig(event);
			bootOnce(env, {
				dev: import.meta.dev,
				baseUrl: config.baseUrl as string,
				oauthClientIds: {
					github: config.public.githubClientId as string,
					gitlab: config.public.gitlabClientId as string,
					cloudflare: config.public.cloudflareClientId as string
				}
			});
		} catch (error) {
			console.error('boot failed; sign-in stays closed', error);
		}
	});
});

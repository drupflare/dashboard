import { defineTask } from 'nitropack/runtime';
import {
	collectUsage,
	usageCollectDepsFor,
	usageCollectInstalled
} from '../services/usage-collect';
import { notInstalled } from '../utils/task-skip';

export default defineTask({
	meta: {
		name: 'usage-collect',
		description:
			'Reads the counted hours of each managed site and stores the hours that have ended'
	},
	async run({ context }): Promise<{ result?: unknown }> {
		const env = (context as { cloudflare?: { env?: Record<string, unknown> } }).cloudflare?.env;
		if (!env) return { result: { skipped: 'the task carries no cloudflare env' } };
		const deps = usageCollectDepsFor(env);
		if (deps === null) {
			if (!usageCollectInstalled()) return notInstalled('usage-collect');
			return { result: { skipped: 'the engine binding or the counts secret is missing' } };
		}
		return { result: await collectUsage(deps) };
	}
});

import { defineTask } from 'nitropack/runtime';
import { DOC_MIRRORS } from '../../shared/doc-mirrors';
import { mirrorDepsOf, refreshMirrors } from '../services/doc-mirror';

export default defineTask({
	meta: {
		name: 'docs-mirror-refresh',
		description:
			'Copies the worker and spool documentation from GitHub at most every 30 minutes'
	},
	async run({ context }): Promise<{ result?: unknown }> {
		const env = (context as { cloudflare?: { env?: { CACHE?: unknown } } }).cloudflare?.env;
		const deps = mirrorDepsOf(env);
		if (!deps) return { result: { skipped: 'the cache binding is missing' } };
		const outcomes = await refreshMirrors(deps, DOC_MIRRORS);
		return { result: outcomes ?? { skipped: 'not due yet' } };
	}
});

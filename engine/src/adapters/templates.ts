import type { D1Database, DurableObjectNamespace } from '@cloudflare/workers-types';
import { INPUT_BYTES_HEADER, type RunRecord, type RunRefusal } from '../containers/jobs';
import type { TemplateRunner, TemplateStore } from '../ports';

export class D1TemplateStore implements TemplateStore {
	constructor(private readonly db: D1Database) {}

	async ready(id: string, patch: { bundleKey: string; manifest: string }): Promise<void> {
		await this.db
			.prepare(
				`UPDATE template_bundles SET status = 'ready', bundle_key = ?, manifest = ?, failure = NULL
				WHERE id = ?`
			)
			.bind(patch.bundleKey, patch.manifest, id)
			.run();
	}

	async fail(id: string, failure: string): Promise<void> {
		await this.db
			.prepare(
				`UPDATE template_bundles SET status = 'failed', failure = ? WHERE id = ? AND status = 'building'`
			)
			.bind(failure.slice(0, 4096), id)
			.run();
	}
}

// one runner instance holds one container, so builds queue behind each other by refusal
export function jobRunnerOf(namespace: DurableObjectNamespace): TemplateRunner {
	return {
		async run({ key, input }) {
			const stub = namespace.get(namespace.idFromName('template-build'));
			const url = `https://runner/run?kind=template-build&key=${encodeURIComponent(key)}`;
			const response = await stub.fetch(url, {
				method: 'POST',
				body: input,
				headers: { [INPUT_BYTES_HEADER]: String(input.byteLength) }
			});
			const text = await response.text();
			let answer: unknown;
			try {
				answer = JSON.parse(text);
			} catch {
				throw new Error(`the job runner answered ${response.status} without a record`);
			}
			if (answer === null || typeof answer !== 'object') {
				throw new Error(`the job runner answered ${response.status} without a record`);
			}
			return answer as RunRecord | RunRefusal;
		}
	};
}

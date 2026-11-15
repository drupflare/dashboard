import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
	CorpusInvalidError,
	corpusSourcesSchema,
	parseCorpusManifest,
	type CorpusManifest,
	type CorpusSources
} from '../src/shared/corpus';

export const corpusTarget = fileURLToPath(new URL('../src/shared/corpus.json', import.meta.url));

// validates before writing, so a refused manifest leaves the target untouched
export async function syncCorpus(
	workerDir: string,
	target = corpusTarget
): Promise<CorpusManifest> {
	const raw = await readFile(join(workerDir, 'docs', 'compatibility.json'), 'utf8');
	const manifest = parseCorpusManifest(raw);
	await writeFile(target, raw);
	return manifest;
}

export const sourcesTarget = fileURLToPath(
	new URL('../src/shared/corpus-sources.json', import.meta.url)
);

// where each codebase lives and what its run with the legacy layer found; a run for another commit
// describes a different codebase, so it is dropped here
export async function syncSources(
	workerDir: string,
	manifest: CorpusManifest,
	target = sourcesTarget
): Promise<CorpusSources> {
	const config = parseYaml(await readFile(join(workerDir, 'config', 'corpus.yml'), 'utf8')) as {
		repos: { id: string; repo: string; shape: string; core: string | number }[];
	};
	const legacyPath = join(workerDir, 'docs', 'compatibility-anachron.json');
	const legacy = existsSync(legacyPath)
		? parseCorpusManifest(await readFile(legacyPath, 'utf8')).repos
		: {};
	const byId = new Map(config.repos.map((entry) => [entry.id, entry]));
	const sources: CorpusSources = {};
	for (const [id, entry] of Object.entries(manifest.repos)) {
		const configured = byId.get(id);
		if (!configured)
			throw new CorpusInvalidError(`${id} is in the manifest and not in corpus.yml`);
		const ran = legacy[id];
		sources[id] = {
			repo: configured.repo,
			shape: configured.shape,
			core: String(configured.core),
			legacy:
				ran && ran.sha === entry.sha
					? { sha: ran.sha, date: ran.date, rows: ran.rows }
					: null
		};
	}
	const parsed = corpusSourcesSchema.parse(sources);
	await writeFile(target, `${JSON.stringify(parsed, null, '\t')}\n`);
	return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const workerDir = resolve(process.cwd(), process.argv[2] ?? '../worker');
	const manifest = await syncCorpus(workerDir);
	console.log(`wrote ${corpusTarget} (${Object.keys(manifest.repos).length} codebases)`);
	const sources = await syncSources(workerDir, manifest);
	const legacy = Object.values(sources).filter((source) => source.legacy !== null).length;
	console.log(`wrote ${sourcesTarget} (${legacy} with a legacy layer run)`);
}

import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCorpusManifest, type CorpusManifest } from '../src/shared/corpus';

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const workerDir = resolve(process.cwd(), process.argv[2] ?? '../worker');
	const manifest = await syncCorpus(workerDir);
	console.log(`wrote ${corpusTarget} (${Object.keys(manifest.repos).length} codebases)`);
}

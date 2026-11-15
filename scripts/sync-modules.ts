import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	parseModuleManifestValue,
	type ModuleManifest,
	type ModuleRow,
	type ModuleState
} from '../src/shared/modules';

export const modulesTarget = fileURLToPath(new URL('../src/shared/modules.json', import.meta.url));

export interface WorkerCensus {
	rows: { name: string; label: string; state: ModuleState; evidence: string }[];
	shipping: readonly string[];
	needs: Readonly<Record<string, readonly string[]>>;
}

type WorkerTable = {
	moduleTable(): WorkerCensus['rows'];
	SHIPPING_PACK_CONTRIB: readonly string[];
};
type WorkerCatalog = { KNOWN_MODULE_CAPABILITIES: Readonly<Record<string, readonly string[]>> };
type WorkerTiers = {
	allKnownCapabilities(
		shipped: Readonly<Record<string, readonly string[]>>
	): WorkerCensus['needs'];
};

// the worker's own classifier, so a row cannot drift from what the worker serves
export async function loadWorkerCensus(workerDir: string): Promise<WorkerCensus> {
	const load = (file: string) => import(pathToFileURL(join(workerDir, 'src/ops', file)).href);
	const table = (await load('module-table.ts')) as WorkerTable;
	const catalog = (await load('catalog.ts')) as WorkerCatalog;
	const tiers = (await load('module-tiers.ts')) as WorkerTiers;
	return {
		rows: table.moduleTable(),
		shipping: table.SHIPPING_PACK_CONTRIB,
		needs: tiers.allKnownCapabilities(catalog.KNOWN_MODULE_CAPABILITIES)
	};
}

// the worker has no kind or title field, so kind stays unknown
export function manifestOf(census: WorkerCensus): ModuleManifest {
	const modules = census.rows.map((row): ModuleRow => ({
		name: row.name,
		label: row.label,
		kind: 'unknown',
		state: row.state,
		shipping: census.shipping.includes(row.name),
		...(row.state === 'blocked' ? { reason: row.evidence } : {}),
		needs: [...(census.needs[row.name] ?? [])]
	}));
	return parseModuleManifestValue({ modules });
}

// validates before writing, so a refused census leaves the target untouched
export async function syncModules(
	workerDir: string,
	target = modulesTarget,
	load: (dir: string) => Promise<WorkerCensus> = loadWorkerCensus
): Promise<ModuleManifest> {
	const manifest = manifestOf(await load(workerDir));
	await writeFile(target, `${JSON.stringify(manifest, null, '\t')}\n`);
	return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const workerDir = resolve(process.cwd(), process.argv[2] ?? '../worker');
	const manifest = await syncModules(workerDir);
	console.log(`wrote ${modulesTarget} (${manifest.modules.length} modules)`);
}

import { sha256Hex, utf8 } from '@contracts/common';
import { parseTar, tarEntryTree, TarParseError, TarPathError } from '@drupflare/untarl';
import { z } from 'zod';
import type { Finding, Provenance, Recipe } from '../../src/shared/recipes';
import { inferRecipe } from '../../src/shared/recipes/custom';
import {
	assetHashOf,
	BUNDLE_VERSION,
	BundleError,
	bundleKeys,
	checkMetadataBytes,
	validateBundle,
	type BundleLimits,
	type BundleManifest
} from './bundle';
import type { Releases } from './ports';

// the isolate holds the archive, its inflated bytes and the parser's copy of every entry at once,
// and it has 128 MB; these stay well inside that
export const CUSTOM_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;
export const CUSTOM_EXPANDED_MAX_BYTES = 40 * 1024 * 1024;
export const CUSTOM_MAX_ENTRIES = 20_000;
export const CUSTOM_MAX_PATH_CHARS = 512;

// stricter than the engine's own ceilings, so a bundle the intake accepts is one the engine takes
export const CUSTOM_BUNDLE_LIMITS: BundleLimits = {
	maxModuleBytes: 10 * 1024 * 1024,
	maxTotalBytes: CUSTOM_EXPANDED_MAX_BYTES,
	maxAssetBytes: 25 * 1024 * 1024,
	maxAssets: 20_000
};

// a binding becomes part of a bucket or database name, which is capped at 63 characters
export const CUSTOM_BINDING_MAX = 20;

export const CUSTOM_ARCHIVE_ERRORS = [
	'archive_too_large',
	'archive_unreadable',
	'archive_expanded_too_large',
	'archive_too_many_entries',
	'archive_unsafe_path',
	'archive_link',
	'no_config',
	'config_invalid'
] as const;
export type CustomArchiveErrorCode = (typeof CUSTOM_ARCHIVE_ERRORS)[number];

export class CustomBundleError extends Error {
	constructor(
		readonly code: CustomArchiveErrorCode,
		message: string
	) {
		super(message);
		this.name = 'CustomBundleError';
	}
}

export const customKeys = {
	archive: (orgId: string, sha256: string) => `custom/${orgId}/${sha256}`
};

export const customReleasePrefix = 'cust-';

export async function customReleaseId(orgId: string, sha256: string): Promise<string> {
	return `${customReleasePrefix}${(await sha256Hex(`${orgId}:${sha256}`)).slice(0, 32)}`;
}

export const isCustomRelease = (releaseId: string) => releaseId.startsWith(customReleasePrefix);

// #region the deploy spec kept as the release's metadata.json

export const customSpecSchema = z.strictObject({
	v: z.literal(1),
	compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	compatibilityFlags: z.array(z.string()),
	resources: z.array(
		z.strictObject({ kind: z.enum(['kv', 'r2', 'd1']), binding: z.string().min(1) })
	),
	sendEmail: z.array(z.string().min(1)),
	durableObjects: z.array(
		z.strictObject({ name: z.string().min(1), class_name: z.string().min(1) })
	),
	migrations: z.array(
		z.strictObject({ tag: z.string().min(1), new_sqlite_classes: z.array(z.string()) })
	),
	crons: z.array(z.string()),
	vars: z.record(z.string(), z.string()),
	assetsBinding: z.string().min(1).nullable()
});
export type CustomSpec = z.infer<typeof customSpecSchema>;

export function parseCustomSpec(bytes: Uint8Array): CustomSpec {
	let json: unknown;
	try {
		json = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new BundleError('malformed', 'the custom release spec is not JSON');
	}
	const parsed = customSpecSchema.safeParse(json);
	if (!parsed.success) {
		throw new BundleError('malformed', 'the custom release spec is not valid');
	}
	return parsed.data;
}

export async function loadCustomSpec(
	releases: Releases,
	limits: BundleLimits,
	releaseId: string
): Promise<CustomSpec> {
	const manifest = validateBundle(await releases.manifest(releaseId), limits);
	const bytes = await releases.part(bundleKeys.metadata(releaseId));
	await checkMetadataBytes(manifest, bytes);
	return parseCustomSpec(bytes);
}

export type GuardShape = Pick<CustomSpec, 'durableObjects' | 'migrations'>;

// the dashboard guards an update from the stored recipe, the engine from the release's own spec
export const guardShapeOf = (recipe: Recipe): GuardShape => ({
	durableObjects: recipe.durableObjects.map((object) => ({
		name: object.binding,
		class_name: object.className
	})),
	migrations: recipe.durableMigrations.map((step) => ({
		tag: step.tag,
		new_sqlite_classes: step.newSqliteClasses
	}))
});

// a deployed class may not disappear: its data would be orphaned with no way to read it back
export function removedClasses(live: GuardShape, target: GuardShape): string[] {
	const kept = new Set(target.durableObjects.map((object) => object.class_name));
	return [...new Set(live.durableObjects.map((object) => object.class_name))].filter(
		(name) => !kept.has(name)
	);
}

// migrations may only add tags: every tag the live release holds stays, in the same order, and
// a tag never changes what it names
export function customMigrationRefusal(live: GuardShape, target: GuardShape): string | null {
	const gone = removedClasses(live, target);
	if (gone.length > 0) {
		return `the bundle removes the ${gone.join(', ')} class that the running site stores data in`;
	}
	for (const [index, step] of live.migrations.entries()) {
		const next = target.migrations[index];
		if (next === undefined) return `the bundle drops the migration step ${step.tag}`;
		if (
			next.tag !== step.tag ||
			next.new_sqlite_classes.join('\u0000') !== step.new_sqlite_classes.join('\u0000')
		) {
			return `the bundle changes the migration step ${step.tag}; steps may only be added`;
		}
	}
	return null;
}

// #endregion

// #region reading the archive

export async function readStreamCapped(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
	code: 'archive_too_large' | 'archive_expanded_too_large' = 'archive_too_large'
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new CustomBundleError(code, `the archive is larger than ${maxBytes} bytes`);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

// the count stops the inflate at the first byte past the cap, so a bomb never sits in memory
async function inflateCapped(archive: Uint8Array, maxBytes: number): Promise<Uint8Array> {
	const gunzip = new DecompressionStream('gzip') as ReadableWritablePair<Uint8Array, Uint8Array>;
	try {
		return await readStreamCapped(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(archive);
					controller.close();
				}
			}).pipeThrough(gunzip),
			maxBytes,
			'archive_expanded_too_large'
		);
	} catch (error) {
		if (error instanceof CustomBundleError) throw error;
		throw new CustomBundleError('archive_unreadable', 'the archive is not a valid .tar.gz');
	}
}

const LINK_FLAGS = new Set(['1', '2', '3', '4', '6']);

// the parser drops links without a word; a built bundle with one is broken, so the intake says so.
// The structure is already valid here, so the walk needs no bounds checks of its own
function linkIn(tar: Uint8Array): string | null {
	let offset = 0;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) return null;
		const flag = String.fromCharCode(header[156] ?? 0);
		const name = new TextDecoder().decode(header.subarray(0, 100)).replace(/\0.*$/s, '');
		if (LINK_FLAGS.has(flag)) return name;
		const size = Number.parseInt(
			new TextDecoder().decode(header.subarray(124, 136)).replace(/[\0 ]+/g, '') || '0',
			8
		);
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return null;
}

// a wrapping directory is dropped when the config is not at the top: `tar czf x.tgz dist/` is common
function unwrapped(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
	if ([...files.keys()].some((path) => /^wrangler\.jsonc?$/.test(path))) return files;
	const tops = new Set([...files.keys()].map((path) => path.split('/')[0]));
	if (tops.size !== 1) return files;
	const top = [...tops][0]!;
	const inside = new Map<string, Uint8Array>();
	for (const [path, bytes] of files) {
		if (path.includes('/')) inside.set(path.slice(top.length + 1), bytes);
	}
	return [...inside.keys()].some((path) => /^wrangler\.jsonc?$/.test(path)) ? inside : files;
}

export async function unpackArchive(archive: Uint8Array): Promise<Map<string, Uint8Array>> {
	if (archive.byteLength > CUSTOM_ARCHIVE_MAX_BYTES) {
		throw new CustomBundleError(
			'archive_too_large',
			`the archive is larger than ${CUSTOM_ARCHIVE_MAX_BYTES} bytes`
		);
	}
	const tar = await inflateCapped(archive, CUSTOM_EXPANDED_MAX_BYTES);
	let entries;
	try {
		entries = parseTar(tar);
	} catch (error) {
		if (error instanceof TarParseError) {
			throw new CustomBundleError(
				'archive_unreadable',
				`the archive is damaged: ${error.message}`
			);
		}
		throw error;
	}
	if (entries.length > CUSTOM_MAX_ENTRIES) {
		throw new CustomBundleError(
			'archive_too_many_entries',
			`the archive holds ${entries.length} entries, over the limit of ${CUSTOM_MAX_ENTRIES}`
		);
	}
	for (const entry of entries) {
		if (entry.name.length > CUSTOM_MAX_PATH_CHARS || entry.name.includes('\\')) {
			throw new CustomBundleError(
				'archive_unsafe_path',
				`${entry.name.slice(0, 80)} is not a usable path`
			);
		}
	}
	let files: Map<string, Uint8Array>;
	try {
		files = tarEntryTree(entries, 0);
	} catch (error) {
		if (error instanceof TarPathError) {
			throw new CustomBundleError(
				'archive_unsafe_path',
				`${error.path} leaves the archive's own directory`
			);
		}
		throw error;
	}
	const link = linkIn(tar);
	if (link !== null) {
		throw new CustomBundleError(
			'archive_link',
			`${link} is a link; upload the built files themselves`
		);
	}
	return unwrapped(files);
}

// #endregion

// #region the config

// comments and trailing commas outside strings; the rest is plain JSON
export function parseJsonc(source: string): unknown {
	const out: string[] = [];
	let comma = -1;
	let i = source.charCodeAt(0) === 0xfeff ? 1 : 0;
	while (i < source.length) {
		const char = source[i]!;
		if (char === '"') {
			let j = i + 1;
			while (j < source.length && source[j] !== '"') j += source[j] === '\\' ? 2 : 1;
			out.push(source.slice(i, j + 1));
			comma = -1;
			i = j + 1;
		} else if (char === '/' && source[i + 1] === '/') {
			while (i < source.length && source[i] !== '\n') i++;
		} else if (char === '/' && source[i + 1] === '*') {
			const end = source.indexOf('*/', i + 2);
			i = end === -1 ? source.length : end + 2;
		} else if (char === ',') {
			comma = out.length;
			out.push(char);
			i++;
		} else {
			if ((char === '}' || char === ']') && comma !== -1) out[comma] = '';
			if (!/\s/.test(char)) comma = -1;
			out.push(char);
			i++;
		}
	}
	return JSON.parse(out.join(''));
}

// #endregion

// #region building the release

export interface CustomBuild {
	findings: Finding[];
	deployable: boolean;
	recipe: Recipe;
	fileName: string;
	// null when a blocking finding stands, so nothing is stored
	bundle: null | {
		manifest: BundleManifest;
		spec: CustomSpec;
		metadata: Uint8Array;
		modules: { name: string; bytes: Uint8Array }[];
		assets: { path: string; hash: string; bytes: Uint8Array }[];
	};
}

const MODULE_TYPES: Record<string, BundleManifest['modules'][number]['contentType']> = {
	js: 'application/javascript+module',
	mjs: 'application/javascript+module',
	cjs: 'application/javascript',
	wasm: 'application/wasm',
	txt: 'text/plain',
	html: 'text/plain',
	sql: 'text/plain'
};

const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// a resource name ends in the binding, and a bucket name cannot begin or end with a hyphen
const SIZED_BINDING_NAME = /^[A-Za-z]([A-Za-z0-9_]*[A-Za-z0-9])?$/;

const extensionOf = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase();
const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const clean = (path: string) =>
	path
		.split('/')
		.filter((part) => part !== '' && part !== '.')
		.join('/');

function at(key: string): Provenance {
	return { source: `wrangler.jsonc:${key}` };
}

export async function buildCustomBundle(input: {
	files: Map<string, Uint8Array>;
	archiveSha256: string;
	releaseId: string;
	today: string;
}): Promise<CustomBuild> {
	const { files } = input;
	const fileName = files.has('wrangler.jsonc') ? 'wrangler.jsonc' : 'wrangler.json';
	const raw = files.get(fileName);
	if (raw === undefined) {
		throw new CustomBundleError(
			'no_config',
			'The archive has no wrangler.jsonc at its top level'
		);
	}
	let config: unknown;
	try {
		config = parseJsonc(new TextDecoder().decode(raw));
	} catch {
		throw new CustomBundleError('config_invalid', `${fileName} is not valid JSON`);
	}
	if (typeof config !== 'object' || config === null || Array.isArray(config)) {
		throw new CustomBundleError('config_invalid', `${fileName} must hold one object`);
	}
	const row = config as Record<string, unknown>;
	const inferred = inferRecipe(row);
	const findings = [...inferred.findings];
	const block = (code: string, subject: string, reason: string) =>
		findings.push({ severity: 'blocking', code, subject, reason, provenance: at(subject) });
	const note = (severity: 'warning' | 'info', code: string, subject: string, reason: string) =>
		findings.push({ severity, code, subject, reason, provenance: at(subject) });

	// #region entry and dates
	const main = typeof row.main === 'string' ? clean(row.main) : null;
	if (main === null) {
		block(
			'main-missing',
			'main',
			'wrangler.jsonc sets no main. Set main to the built entry file.'
		);
	} else if (!files.has(main)) {
		block('main-not-found', 'main', `main names ${main}, which is not in the archive.`);
	} else if (!['js', 'mjs'].includes(extensionOf(main))) {
		block(
			'main-not-built',
			'main',
			`main is ${main}. Upload the built JavaScript file, not source.`
		);
	}
	const date = typeof row.compatibility_date === 'string' ? row.compatibility_date : null;
	if (date === null) {
		block(
			'compat-date-missing',
			'compatibility_date',
			'wrangler.jsonc sets no compatibility_date. Set the date your code was built and tested against.'
		);
	} else if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		block(
			'compat-date-invalid',
			'compatibility_date',
			`${date} is not a date written YYYY-MM-DD.`
		);
	} else if (date > input.today) {
		block('compat-date-future', 'compatibility_date', `${date} is later than today.`);
	}
	for (const key of ['limits', 'placement']) {
		if (row[key] !== undefined) {
			note(
				'info',
				`${key}-ignored`,
				key,
				`${key} is ignored. The platform sets CPU and subrequest limits per call from the plan.`
			);
		}
	}
	// #endregion

	// #region bindings
	const spec = {
		v: 1 as const,
		compatibilityDate: date ?? '1970-01-01',
		compatibilityFlags: inferred.recipe.compatibility.flags,
		resources: [] as CustomSpec['resources'],
		sendEmail: [] as string[],
		durableObjects: inferred.recipe.durableObjects.map((object) => ({
			name: object.binding,
			class_name: object.className
		})),
		migrations: inferred.recipe.durableMigrations.map((step) => ({
			tag: step.tag,
			new_sqlite_classes: step.newSqliteClasses
		})),
		crons: inferred.recipe.crons.map((cron) => cron.schedule),
		vars: {} as Record<string, string>,
		assetsBinding:
			typeof (row.assets as { binding?: unknown } | undefined)?.binding === 'string'
				? (row.assets as { binding: string }).binding
				: null
	};
	const names = new Set<string>();
	const lowered = new Set<string>();
	const claim = (name: string, subject: string, sized: boolean) => {
		if (!BINDING_NAME.test(name) || (sized && !SIZED_BINDING_NAME.test(name))) {
			block('binding-name-invalid', subject, `${name} is not a usable binding name.`);
		} else if (sized && name.length > CUSTOM_BINDING_MAX) {
			block(
				'binding-name-too-long',
				subject,
				`${name} is longer than ${CUSTOM_BINDING_MAX} characters.`
			);
		} else if (names.has(name) || (sized && lowered.has(name.toLowerCase()))) {
			block('binding-name-duplicate', subject, `${name} is used for two bindings.`);
		}
		names.add(name);
		if (sized) lowered.add(name.toLowerCase());
	};
	for (const resource of inferred.recipe.resources) {
		if (resource.kind === 'send_email') {
			claim(resource.binding, 'send_email', false);
			spec.sendEmail.push(resource.binding);
		} else {
			claim(resource.binding, resource.kind, true);
			spec.resources.push({ kind: resource.kind, binding: resource.binding });
			if (resource.migrationsDir !== undefined) {
				note(
					'info',
					'd1-migrations-not-applied',
					'd1_databases',
					'D1 migration files are not applied for you. The database starts empty.'
				);
			}
		}
	}
	for (const object of spec.durableObjects) claim(object.name, 'durable_objects', false);
	const classes = new Set(spec.migrations.flatMap((step) => step.new_sqlite_classes));
	for (const object of spec.durableObjects) {
		if (!classes.has(object.class_name)) {
			block(
				'durable-object-no-migration',
				'durable_objects',
				`${object.class_name} has no migration that creates it. Add a migrations step with new_sqlite_classes.`
			);
		}
	}
	if (typeof row.vars === 'object' && row.vars !== null && !Array.isArray(row.vars)) {
		for (const [name, value] of Object.entries(row.vars)) {
			claim(name, `vars.${name}`, false);
			if (
				typeof value === 'string' ||
				typeof value === 'number' ||
				typeof value === 'boolean'
			) {
				spec.vars[name] = String(value);
			} else {
				block(
					'var-unsupported',
					`vars.${name}`,
					`vars.${name} must be text, a number, true or false.`
				);
			}
		}
	}
	if (spec.assetsBinding !== null) claim(spec.assetsBinding, 'assets', false);
	if (spec.crons.length > 0) {
		note(
			'warning',
			'cron-not-applied',
			'triggers.crons',
			'Schedules are not applied yet, so the site will not run its scheduled handler.'
		);
	}
	// #endregion

	// #region modules and assets
	const assetDir =
		typeof (row.assets as { directory?: unknown } | undefined)?.directory === 'string'
			? clean((row.assets as { directory: string }).directory)
			: null;
	const inAssets = (path: string) =>
		assetDir !== null &&
		assetDir !== '' &&
		(path === assetDir || path.startsWith(`${assetDir}/`));
	const base = main === null ? '' : dirOf(main);
	const modules: { name: string; bytes: Uint8Array }[] = [];
	const assets: { path: string; hash: string; bytes: Uint8Array }[] = [];
	for (const [path, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
		if (path === fileName) continue;
		if (inAssets(path)) {
			assets.push({
				path: `/${path.slice(assetDir!.length + 1)}`,
				hash: await assetHashOf(bytes),
				bytes
			});
		} else if (
			(base === '' || path.startsWith(`${base}/`)) &&
			MODULE_TYPES[extensionOf(path)] !== undefined
		) {
			modules.push({ name: base === '' ? path : path.slice(base.length + 1), bytes });
		}
	}
	if (assetDir !== null && assets.length === 0) {
		note('info', 'assets-empty', 'assets', `The assets directory ${assetDir} holds no files.`);
	}
	// #endregion

	const recipe: Recipe = { ...inferred.recipe };
	recipe.refused = findings
		.filter((finding) => finding.severity === 'blocking')
		.map((finding) => ({
			kind: finding.subject,
			reason: finding.reason,
			provenance: finding.provenance
		}));
	const mainName = main === null ? null : base === '' ? main : main.slice(base.length + 1);
	let manifest: BundleManifest | null = null;
	let metadata = new Uint8Array();
	if (!findings.some((finding) => finding.severity === 'blocking') && mainName !== null) {
		metadata = utf8(JSON.stringify(spec));
		manifest = {
			v: BUNDLE_VERSION,
			releaseId: input.releaseId,
			workerCommit: input.archiveSha256.slice(0, 40),
			mainModule: mainName,
			modules: await Promise.all(
				modules.map(async ({ name, bytes }) => ({
					name,
					contentType: MODULE_TYPES[extensionOf(name)]!,
					sha256: await sha256Hex(bytes),
					size: bytes.byteLength
				}))
			),
			metadata: { sha256: await sha256Hex(metadata), size: metadata.byteLength },
			assets: assets.map(({ path, hash, bytes }) => ({ path, hash, size: bytes.byteLength })),
			counts: { modules: modules.length, assets: assets.length }
		};
		try {
			validateBundle(manifest, CUSTOM_BUNDLE_LIMITS);
		} catch (error) {
			if (!(error instanceof BundleError)) throw error;
			block(error.code, 'bundle', `${error.message}.`);
			manifest = null;
		}
	}
	const deployable = !findings.some((finding) => finding.severity === 'blocking');
	return {
		findings,
		deployable,
		recipe,
		fileName,
		bundle:
			deployable && manifest !== null
				? { manifest, spec: spec as CustomSpec, metadata, modules, assets }
				: null
	};
}

// writes the release in the layout the engine's release store reads
export async function putCustomBundle(
	blobs: { put(key: string, bytes: Uint8Array): Promise<void> },
	releaseId: string,
	bundle: NonNullable<CustomBuild['bundle']>
): Promise<void> {
	for (const { name, bytes } of bundle.modules) {
		await blobs.put(bundleKeys.module(releaseId, name), bytes);
	}
	for (const { hash, bytes } of bundle.assets) {
		await blobs.put(bundleKeys.asset(releaseId, hash), bytes);
	}
	await blobs.put(bundleKeys.metadata(releaseId), bundle.metadata);
	// the manifest goes last: a release with a manifest has all its parts
	await blobs.put(bundleKeys.manifest(releaseId), utf8(JSON.stringify(bundle.manifest)));
}

// #endregion

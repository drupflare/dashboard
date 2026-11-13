import { utf8 } from '@contracts/common';
import type { Plan } from '@contracts/operations';
import { HOUR_MS, type ImportCap } from '../../../src/shared/import-hours';
import { FILES_BODY_BYTES } from '../../../src/shared/restore-limits';
import { DEFAULT_RESTORE_CEILING_BYTES, joinParts, restorable } from '../backup-parts';
import { convertFiles, filesArchiveLimit } from '../files-convert';
import {
	CACHE_STRUCTURE_ONLY,
	DUMP_LIMIT_FACTOR,
	FILES_LIMIT_BYTES,
	ImportError,
	importKeys,
	PART_BYTES,
	readWindow
} from '../import-parts';
import { buildPlan, observe, setVerification, transition } from '../operations/state';
import type { DumpDialect, ImportDeps, LandTarget, SiteCall } from '../ports';
import { planResources } from '../provision-plan';
import { StepFailed, type StepRunner } from '../step';
import { openSite } from './backup-create';
import {
	acquireLease,
	closeFailed,
	describeFailure,
	fenced,
	finishSuccess,
	plainStep,
	releaseLease,
	runStep,
	startOperation,
	type Ctx,
	type Outcome
} from './common';
import { chooseRoute, finishRestore, landPaged } from './restore-pages';
import { cleanTarget } from './site-cleanup';
import {
	activate,
	applyAuthority,
	createResource,
	firstRun,
	putRoute,
	reserveName,
	uploadAssets,
	uploadScript,
	type FirstRunSealed,
	type SiteCreateInput
} from './site-create';

export interface SiteImportInput {
	operationId: string;
	orgId: string;
	// the sealed key of this import; the key itself is never a parameter
	credentialId: string;
	root: string;
	// what the survey found, as far as the workflow needs it
	dossier: {
		importable: boolean;
		estimateBytes: number | null;
		fileCount: number | null;
		// the database the server runs; mysql when absent
		dialect?: DumpDialect;
		// the private files folder as the survey read it, or none
		privatePath?: string | null;
	};
	// the managed site, built as a create builds it; its first run reads the owner token only
	create: SiteCreateInput & { firstRun: SiteCall };
	waitMs: number;
	pollMs: number;
	restoreCeilingBytes?: number;
	// the size of a dump part and of a conversion window
	partBytes?: number;
}

// assumptions until Gregory sets them; no route or screen reads these numbers
export const ASSUMED_IMPORT_HOUR_CAPS: {
	jobHours: number;
	plans: Readonly<Record<string, ImportCap>>;
} = {
	jobHours: 0.5,
	plans: {
		'managed-free': { perMonthHours: 1, perDayHours: 0.5 },
		'managed-site': { perMonthHours: 3, perDayHours: 1 },
		'managed-studio': { perMonthHours: 6, perDayHours: 2 },
		'managed-agency': { perMonthHours: 15, perDayHours: 4 },
		'institution-starter': 'approval',
		'institution-standard': 'approval'
	}
};

export const IMPORT_JOB_MS = ASSUMED_IMPORT_HOUR_CAPS.jobHours * HOUR_MS;

const RESTORE_IDS = { restore: 'restore', apply: 'apply', verify: 'verify' };

export function planSiteImport(input: SiteImportInput): Plan {
	const { create } = input;
	const resources = planResources(create.site, create.site.config, { database: create.database });
	const files = (input.dossier.fileCount ?? 0) > 0;
	const priv = hasPrivate(input);
	return buildPlan({
		type: 'site.import',
		targetIds: [create.site.id, input.credentialId],
		preconditions: [
			'the owner confirmed the host key of the server',
			'the survey found nothing that stops the import',
			`${create.subdomain} is free`,
			`release ${create.releaseId} is published`
		],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'preflight', name: 'Check the import' },
			{ id: 'dump', name: 'Stream the database dump into the bucket' },
			...(files ? [{ id: 'files-archive', name: 'Stream the files into the bucket' }] : []),
			...(priv
				? [{ id: 'private-archive', name: 'Stream the private files into the bucket' }]
				: []),
			{ id: 'convert', name: 'Convert the dump for the new site' },
			...(files ? [{ id: 'files-convert', name: 'Convert the files for the new site' }] : []),
			...(priv
				? [{ id: 'private-convert', name: 'Convert the private files for the new site' }]
				: []),
			{ id: 'reserve-name', name: `Reserve ${create.subdomain}` },
			...resources.create.map((resource) => ({
				id: `resource.${resource.binding}`,
				name: `Create ${resource.kind} ${resource.name}`
			})),
			{ id: 'assets', name: 'Upload static assets' },
			{ id: 'upload-script', name: 'Upload the script' },
			{ id: 'authority', name: 'Write site authority' },
			{ id: 'route', name: `Route ${create.hostname}` },
			{ id: 'first-run', name: 'Run the first-run call' },
			{ id: 'link', name: 'Record the server the site came from' },
			{ id: RESTORE_IDS.restore, name: 'Send the converted database to the new site' },
			{ id: RESTORE_IDS.apply, name: 'Wait for the new site to apply the database' },
			{ id: RESTORE_IDS.verify, name: 'Probe the new site' },
			{ id: 'activate', name: 'Mark the new site active' },
			{ id: 'forget', name: 'Delete the key and the copies in the bucket' }
		],
		rollbackPoint: null
	});
}

// the reused step functions run under their own step names, so the same name in a create and an
// import never meets in one workflow instance
function phase(ctx: Ctx, prefix: string): Ctx {
	return { ...ctx, step: { do: (name, fn) => ctx.step.do(`${prefix}.${name}`, fn) } };
}

const dialectOf = (input: SiteImportInput): DumpDialect => input.dossier.dialect ?? 'mysql';
const privatePathOf = (input: SiteImportInput) => input.dossier.privatePath ?? null;
const hasPrivate = (input: SiteImportInput) => (privatePathOf(input) ?? '') !== '';

const ceilingOf = (input: SiteImportInput) =>
	input.restoreCeilingBytes ?? DEFAULT_RESTORE_CEILING_BYTES;
const partBytesOf = (input: SiteImportInput) => input.partBytes ?? PART_BYTES;

// #region the source

async function preflight(ctx: Ctx, deps: ImportDeps, input: SiteImportInput): Promise<number> {
	return runStep(ctx, 'preflight', 'preflight', async () => {
		await fenced(ctx);
		if (input.create.firstRun.reads?.ownerToken === undefined) {
			throw new ImportError(
				'unsupported_kind',
				`${input.create.site.kind} sites are not imported`
			);
		}
		if (!input.dossier.importable) {
			throw new ImportError(
				'dossier_refused',
				'the survey found a reason this site is not imported'
			);
		}
		// the clock starts at the first connection to the server
		const startedAt = await deps.imports.beginRun(input.operationId, input.orgId, deps.now());
		// the key opens and the host key is confirmed; no command is sent to the server
		await deps.imports.withTarget(input.credentialId, input.orgId, input.root, async () => {});
		return startedAt;
	});
}

interface Streamed {
	parts: number;
	bytes: number;
}

async function stream(
	ctx: Ctx,
	deps: ImportDeps,
	input: SiteImportInput,
	kind: 'database' | 'files' | 'private'
): Promise<Streamed> {
	const database = kind === 'database';
	const name = database ? 'dump' : kind === 'files' ? 'files-archive' : 'private-archive';
	return runStep(ctx, name, name, async () => {
		await fenced(ctx);
		const prefix = database
			? importKeys.dumpPrefix(input.orgId, input.operationId)
			: kind === 'files'
				? importKeys.filesPrefix(input.orgId, input.operationId)
				: importKeys.privatePrefix(input.orgId, input.operationId);
		// a heartbeat after each part keeps the lease alive for a step that outlasts one lease time
		const streamed = await deps.imports.withTarget(
			input.credentialId,
			input.orgId,
			input.root,
			(target) =>
				deps.dump.run(
					target,
					{
						kind,
						prefix,
						partBytes: partBytesOf(input),
						...(database
							? { structureOnly: CACHE_STRUCTURE_ONLY, dialect: dialectOf(input) }
							: {}),
						...(kind === 'private' ? { path: privatePathOf(input) ?? '' } : {}),
						maxBytes: database
							? ceilingOf(input) * DUMP_LIMIT_FACTOR
							: Math.min(
									FILES_LIMIT_BYTES,
									filesArchiveLimit(Math.min(ceilingOf(input), FILES_BODY_BYTES))
								)
					},
					() => fenced(ctx)
				)
		);
		if (database && streamed.bytes === 0) {
			throw new ImportError('dump_empty', 'the server returned an empty database dump');
		}
		return streamed;
	});
}

// #endregion

// #region conversion

// each window starts at the cut the step before it reported, so a replayed step finds its own
// result and the chain picks up where it stopped
async function convertAll(
	ctx: Ctx,
	deps: ImportDeps,
	input: SiteImportInput,
	dump: Streamed
): Promise<Streamed & { lossy: number }> {
	if (dialectOf(input) === 'pgsql') return convertPgAll(ctx, deps, input, dump);
	const partBytes = partBytesOf(input);
	let offset = 0;
	let seq = 0;
	let bytes = 0;
	while (offset < dump.bytes) {
		const at = offset;
		const n = seq;
		const done = await runStep(
			ctx,
			`convert.${n}`,
			'convert',
			async () => {
				await fenced(ctx);
				const window = await readWindow(
					deps.blobs,
					(part) => importKeys.dump(input.orgId, input.operationId, part),
					partBytes,
					dump.bytes,
					at,
					partBytes
				);
				const last = at + window.byteLength >= dump.bytes;
				const converted = await deps.converter.convertChunk(window, last);
				if (converted.cut <= 0) {
					throw new ImportError('dump_failed', 'a conversion step made no progress');
				}
				const sql = utf8(converted.sql);
				await deps.blobs.put(importKeys.sql(input.orgId, input.operationId, n), sql);
				return { cut: converted.cut, bytes: sql.byteLength };
			},
			{ begin: n === 0, finish: false }
		);
		offset += done.cut;
		bytes += done.bytes;
		seq++;
	}
	return runStep(
		ctx,
		'convert.complete',
		'convert',
		async () => {
			if (!restorable(bytes, ceilingOf(input))) {
				throw new ImportError(
					'restore_too_large',
					`the converted database is larger than the ${ceilingOf(input)} bytes a site accepts in a restore`
				);
			}
			return { parts: seq, bytes, lossy: 0 };
		},
		{ begin: false }
	);
}

// a pg_dump is read twice. The first pass finds every cut and keeps the statements that are not
// data; the tables come from those, then each cut is converted with them, and the indexes replay
// last. A part is written under its own key, so a replayed step writes the same one again.
async function convertPgAll(
	ctx: Ctx,
	deps: ImportDeps,
	input: SiteImportInput,
	dump: Streamed
): Promise<Streamed & { lossy: number }> {
	const { orgId, operationId } = input;
	const partBytes = partBytesOf(input);
	const dumpKey = (part: number) => importKeys.dump(orgId, operationId, part);
	const cuts: number[] = [];
	let offset = 0;
	while (offset < dump.bytes) {
		const at = offset;
		const n = cuts.length;
		const { cut } = await runStep(
			ctx,
			`scan.${n}`,
			'convert',
			async () => {
				await fenced(ctx);
				const window = await readWindow(
					deps.blobs,
					dumpKey,
					partBytes,
					dump.bytes,
					at,
					partBytes
				);
				const last = at + window.byteLength >= dump.bytes;
				const scanned = await deps.converter.scanPg(window, last);
				if (scanned.cut <= 0) {
					throw new ImportError('dump_failed', 'a conversion step made no progress');
				}
				await deps.blobs.put(importKeys.ddlPart(orgId, operationId, n), utf8(scanned.ddl));
				return { cut: scanned.cut };
			},
			{ begin: n === 0, finish: false }
		);
		cuts.push(cut);
		offset += cut;
	}

	const schema = await runStep(
		ctx,
		'convert.schema',
		'convert',
		async () => {
			await fenced(ctx);
			const texts: string[] = [];
			for (let n = 0; n < cuts.length; n++) {
				const part = await deps.blobs.get(importKeys.ddlPart(orgId, operationId, n));
				if (part === null) throw new ImportError('part_missing', `part ${n} is missing`);
				texts.push(new TextDecoder().decode(part));
			}
			const ddl = texts.join('\n');
			const converted = await deps.converter.schemaPg(ddl);
			const tables = utf8(converted.tables);
			await deps.blobs.put(importKeys.ddl(orgId, operationId), utf8(ddl));
			await deps.blobs.put(importKeys.sql(orgId, operationId, 0), tables);
			await deps.blobs.put(importKeys.indexes(orgId, operationId), utf8(converted.indexes));
			return { bytes: tables.byteLength, lossy: converted.lossy.length };
		},
		{ begin: false, finish: false }
	);

	let bytes = schema.bytes;
	let at = 0;
	for (const [index, cut] of cuts.entries()) {
		const start = at;
		const n = index + 1;
		const done = await runStep(
			ctx,
			`convert.${n}`,
			'convert',
			async () => {
				await fenced(ctx);
				const stored = await deps.blobs.get(importKeys.ddl(orgId, operationId));
				if (stored === null) throw new ImportError('part_missing', 'the schema is missing');
				const window = await readWindow(
					deps.blobs,
					dumpKey,
					partBytes,
					dump.bytes,
					start,
					cut
				);
				const converted = await deps.converter.dataPg(
					window,
					new TextDecoder().decode(stored)
				);
				const sql = utf8(converted.sql);
				await deps.blobs.put(importKeys.sql(orgId, operationId, n), sql);
				return { bytes: sql.byteLength };
			},
			{ begin: false, finish: false }
		);
		bytes += done.bytes;
		at += cut;
	}

	return runStep(
		ctx,
		'convert.complete',
		'convert',
		async () => {
			const indexes = await deps.blobs.get(importKeys.indexes(orgId, operationId));
			if (indexes === null) throw new ImportError('part_missing', 'the indexes are missing');
			await deps.blobs.put(importKeys.sql(orgId, operationId, cuts.length + 1), indexes);
			const total = bytes + indexes.byteLength;
			if (!restorable(total, ceilingOf(input))) {
				throw new ImportError(
					'restore_too_large',
					`the converted database is larger than the ${ceilingOf(input)} bytes a site accepts in a restore`
				);
			}
			return { parts: cuts.length + 2, bytes: total, lossy: schema.lossy };
		},
		{ begin: false }
	);
}

// the files ride in the same restore body as the database, so they are counted against the one
// ceiling here, before anything is made on the new side; the rows go in as one more part
async function convertArchive(
	ctx: Ctx,
	deps: ImportDeps,
	input: SiteImportInput,
	sql: Streamed,
	archive: Streamed,
	scheme: 'public' | 'private' = 'public'
): Promise<Streamed & { links: number }> {
	const name = scheme === 'public' ? 'files-convert' : 'private-convert';
	return runStep(ctx, name, name, async () => {
		await fenced(ctx);
		const keyOf = scheme === 'public' ? importKeys.files : importKeys.private;
		const tar = await readWindow(
			deps.blobs,
			(part) => keyOf(input.orgId, input.operationId, part),
			partBytesOf(input),
			archive.bytes,
			0,
			archive.bytes
		);
		const converted = convertFiles(tar, {
			nowMs: deps.now(),
			ceilingBytes: ceilingOf(input),
			databaseBytes: sql.bytes,
			scheme
		});
		if (converted.files === 0) return { ...sql, links: converted.links };
		await deps.blobs.put(
			importKeys.sql(input.orgId, input.operationId, sql.parts),
			converted.sql
		);
		return {
			parts: sql.parts + 1,
			bytes: sql.bytes + converted.sql.byteLength,
			links: converted.links
		};
	});
}

// #endregion

// #region landing

async function link(ctx: Ctx, deps: ImportDeps, input: SiteImportInput): Promise<void> {
	await runStep(ctx, 'link', 'link', async () => {
		await fenced(ctx);
		await deps.imports.markImported(
			input.create.site.id,
			input.credentialId,
			input.create.site.accountId,
			deps.now()
		);
	});
}

interface Sent {
	target: LandTarget;
	startedAt: number;
}

async function sendDatabase(
	ctx: Ctx,
	deps: ImportDeps,
	input: SiteImportInput,
	sql: Streamed
): Promise<Sent> {
	const { create } = input;
	const keyOf = (seq: number) => importKeys.sql(input.orgId, input.operationId, seq);
	const sent = await runStep(
		ctx,
		'restore',
		'restore',
		async () => {
			await fenced(ctx);
			const site = await openSite(
				deps,
				{ id: create.site.id, orgId: input.orgId, accountId: create.site.accountId },
				{ notReady: 'target_not_ready', foreign: 'target_other_organisation' }
			);
			const target: LandTarget = {
				siteId: create.site.id,
				hostname: site.hostname,
				ownerTokenId: site.ownerTokenId
			};
			// a body above one request goes through the paged restore, when the new site has it
			const route = await chooseRoute(deps, target, sql.bytes, ceilingOf(input));
			if (route === 'paged') return { target, route };
			const parts: Uint8Array[] = [];
			for (let seq = 0; seq < sql.parts; seq++) {
				const bytes = await deps.blobs.get(keyOf(seq));
				if (bytes === null) throw new ImportError('part_missing', `part ${seq} is missing`);
				parts.push(bytes);
			}
			const body = joinParts(parts);
			if (!restorable(body.byteLength, ceilingOf(input))) {
				throw new ImportError(
					'restore_too_large',
					`the converted database is larger than the ${ceilingOf(input)} bytes a site accepts in a restore`
				);
			}
			await deps.lander.database(target, input.operationId, body);
			return { target, route };
		},
		{ finish: false }
	);
	if (sent.route === 'single') {
		return { target: sent.target, startedAt: await finishRestore(ctx) };
	}
	const startedAt = await landPaged(
		ctx,
		deps,
		{ ...sent.target, label: input.operationId },
		Array.from({ length: sql.parts }, (_, seq) => keyOf(seq)),
		ceilingOf(input)
	);
	return { target: sent.target, startedAt };
}

async function applyDatabase(
	ctx: Ctx,
	deps: ImportDeps,
	input: SiteImportInput,
	sent: Sent
): Promise<void> {
	await runStep(ctx, 'apply', RESTORE_IDS.apply, async () => {
		await fenced(ctx);
		const deadline = sent.startedAt + input.waitMs;
		for (;;) {
			const state = await deps.lander.state(sent.target, input.operationId);
			if (state === 'applied') return;
			if (state === 'failed') {
				const reason = await deps.lander.reason(sent.target, input.operationId);
				throw new ImportError(
					'import_failed',
					`${sent.target.siteId} reported that the import failed${reason === '' ? '' : ` at ${reason}`}`
				);
			}
			if (deps.now() >= deadline) {
				throw new ImportError(
					'import_timeout',
					`${sent.target.siteId} had not applied the database in time`
				);
			}
			await fenced(ctx);
			await deps.sleep(input.pollMs);
		}
	});
}

// the site answers 503 until the replay lands, so the probe runs only after it applied
async function verifySite(
	ctx: Ctx,
	deps: ImportDeps,
	input: SiteImportInput,
	sent: Sent
): Promise<void> {
	await runStep(ctx, 'verify', RESTORE_IDS.verify, async () => {
		await fenced(ctx);
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.status === 'running'
				? transition(operation, 'verifying', deps.now())
				: operation
		);
		const { status } = await deps.site.probe(sent.target.hostname, '/', 200);
		if (status !== 200) throw new Error(`the probe answered ${status}, wanted 200`);
		await deps.imports.endRun(ctx.operationId, deps.now());
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.verification === 'passed'
				? operation
				: setVerification(operation, 'passed', deps.now())
		);
	});
}

// the last step: once the site is live, neither the key nor the copies are needed
async function forget(ctx: Ctx, deps: ImportDeps, input: SiteImportInput): Promise<void> {
	await runStep(ctx, 'forget', 'forget', async () => {
		await fenced(ctx);
		await deps.imports.discard(input.credentialId);
		await deps.blobs.deletePrefix(importKeys.prefix(input.orgId, input.operationId));
	});
}

// #endregion

// #region rollback

// the key and the copies go whatever happened to the site; the source was never written to, so
// only what this operation made on the new side is undone
async function rollback(
	ctx: Ctx,
	deps: ImportDeps,
	input: SiteImportInput,
	failure: StepFailed
): Promise<Outcome> {
	const { create } = input;
	const reason = describeFailure(failure);
	const closed = await closeFailed(ctx, failure);
	if (closed === 'cancelled') {
		await releaseLease(ctx);
		return { status: 'cancelled', reason };
	}
	await plainStep(ctx, 'rollback.run', () => deps.imports.endRun(ctx.operationId, deps.now()));
	const leaked: string[] = [];
	const live = await plainStep(ctx, 'rollback.live', () => deps.store.siteLive(create.site.id));
	const actions: [string, () => Promise<unknown>][] = [
		['credential', () => deps.imports.discard(input.credentialId)],
		['parts', () => deps.blobs.deletePrefix(importKeys.prefix(input.orgId, input.operationId))]
	];
	// a site that went live is kept whole, so nothing is taken off it
	if (!live) {
		actions.push([
			'target',
			() =>
				cleanTarget(deps, ctx.operationId, ctx.purpose, {
					siteId: create.site.id,
					accountId: create.site.accountId,
					plane: create.site.plane,
					hostname: create.hostname,
					subdomain: create.subdomain
				})
		]);
	}
	for (const [name, action] of actions) {
		try {
			await plainStep(ctx, `rollback.${name}`, action);
		} catch (error) {
			if (!(error instanceof StepFailed)) throw error;
			leaked.push(name);
		}
	}
	if (live) {
		await releaseLease(ctx);
		return { status: 'failed', reason, leaked };
	}
	await plainStep(ctx, 'rollback.close', async () => {
		await deps.store.mutate(ctx.operationId, (operation) => {
			if (operation.status === 'rolled-back') return operation;
			return leaked.length === 0
				? transition(
						observe(operation, `rolled back after ${reason}`, deps.now()),
						'rolled-back',
						deps.now()
					)
				: observe(
						operation,
						`rollback incomplete (${leaked.join(', ')}) after ${reason}`,
						deps.now()
					);
		});
	});
	await releaseLease(ctx);
	return leaked.length === 0
		? { status: 'rolled-back', reason }
		: { status: 'failed', reason, leaked };
}

// #endregion

export async function runSiteImport(
	step: StepRunner,
	deps: ImportDeps,
	input: SiteImportInput
): Promise<Outcome> {
	const { create } = input;
	// the lease is on the new site, which no one else holds while it is built
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: create.site.id,
		accountId: create.site.accountId,
		purpose: 'site.import',
		epoch: null
	};
	const resources = planResources(create.site, create.site.config, { database: create.database });
	const carriesFiles = (input.dossier.fileCount ?? 0) > 0;
	let left = 0;
	let lossy = 0;
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		const startedAt = await preflight(ctx, deps, input);
		ctx.deadlineMs = startedAt + IMPORT_JOB_MS;

		const dump = await stream(ctx, deps, input, 'database');
		const archive = carriesFiles ? await stream(ctx, deps, input, 'files') : null;
		const privateArchive = hasPrivate(input) ? await stream(ctx, deps, input, 'private') : null;
		const converted = await convertAll(ctx, deps, input, dump);
		let sql: Streamed = { parts: converted.parts, bytes: converted.bytes };
		for (const [tar, scheme] of [
			[archive, 'public'],
			[privateArchive, 'private']
		] as const) {
			if (tar === null) continue;
			const withFiles = await convertArchive(ctx, deps, input, sql, tar, scheme);
			sql = { parts: withFiles.parts, bytes: withFiles.bytes };
			left += withFiles.links;
		}
		lossy = converted.lossy;

		const target = phase(ctx, 'target');
		await reserveName(target, create);
		for (const [index, resource] of resources.create.entries()) {
			await createResource(target, create, resource, index === 0 ? resources : null);
		}
		const token = await uploadAssets(target, create);
		await uploadScript(target, create, token);
		await applyAuthority(target, create);
		await putRoute(target, create);
		const sealed: FirstRunSealed = await firstRun(target, create, create.firstRun);
		await link(ctx, deps, input);

		const sent = await sendDatabase(ctx, deps, input, sql);
		await applyDatabase(ctx, deps, input, sent);
		await verifySite(ctx, deps, input, sent);
		await activate(target, create, sealed);
		await forget(ctx, deps, input);
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		return rollback(ctx, deps, input, error);
	}
	await finishSuccess(
		ctx,
		`${create.site.id} was imported at ${create.hostname}${left > 0 ? `; ${left} links in the files folder were left behind` : ''}${lossy > 0 ? `; ${lossy} PostgreSQL functions or constraints were left behind` : ''}`
	);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}

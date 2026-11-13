import { createDumpStream } from '../../../../engine/src/adapters/dump-stream';
import {
	edgeportConnector,
	edgeportStreamConnector
} from '../../../../engine/src/adapters/edgeport-ssh';
import { createSqlConverter } from '../../../../engine/src/adapters/sql-converter';
import { openSession } from '../../../../engine/src/adapters/ssh-session';
import { createSshSurvey } from '../../../../engine/src/adapters/ssh-survey';
import { DEFAULT_RESTORE_CEILING_BYTES, restorable } from '../../../../engine/src/backup-parts';
import { convertFiles } from '../../../../engine/src/files-convert';
import {
	CACHE_STRUCTURE_ONLY,
	FILES_LIMIT_BYTES,
	importKeys,
	PART_BYTES,
	readWindow
} from '../../../../engine/src/import-parts';
import type { BackupBlobs, SshTarget } from '../../../../engine/src/ports';
import { dossierFor } from '../../../../src/server/domain/dossier';

interface RunBody extends Omit<SshTarget, 'host'> {
	host: string;
	dialHost: string;
	partBytes?: number;
	// a local worker to land the converted database in, with the site name it serves
	landBase?: string;
	site?: string;
}

const STAND_IN = '93.184.216.34';
const ORG = 'org_rig';
const OP = 'op_rig';

// the real edgeport adapters, with two changes for loopback: the dial goes to the mapped port on
// 127.0.0.1, and the name lookup returns a public stand-in so openSession's address policy passes
function rigConnectors(dialHost: string, answers: string[]) {
	const resolve = async () => answers;
	return {
		survey: {
			...edgeportConnector,
			connect: (options: Parameters<typeof edgeportConnector.connect>[0]) =>
				edgeportConnector.connect({ ...options, hostname: dialHost }),
			resolve
		},
		stream: {
			...edgeportStreamConnector,
			connect: (options: Parameters<typeof edgeportStreamConnector.connect>[0]) =>
				edgeportStreamConnector.connect({ ...options, hostname: dialHost }),
			resolve
		}
	};
}

function memoryBlobs() {
	const map = new Map<string, Uint8Array>();
	const blobs: BackupBlobs = {
		async put(key, bytes) {
			map.set(key, bytes.slice());
		},
		async get(key) {
			return map.get(key) ?? null;
		},
		async deletePrefix(prefix) {
			let removed = 0;
			for (const key of [...map.keys()]) {
				if (key.startsWith(prefix)) {
					map.delete(key);
					removed++;
				}
			}
			return removed;
		}
	};
	return { map, blobs };
}

const keysUnder = (map: Map<string, Uint8Array>, prefix: string) =>
	[...map.keys()].filter((key) => key.startsWith(prefix)).sort();

const sha256 = async (bytes: Uint8Array) =>
	[...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()))]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');

async function timed<T>(steps: Record<string, unknown>[], name: string, fn: () => Promise<T>) {
	const began = performance.now();
	console.log(JSON.stringify({ rigStep: name, phase: 'start' }));
	try {
		const value = await fn();
		steps.push({ step: name, ms: Math.round(performance.now() - began), ok: true });
		return value;
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		steps.push({
			step: name,
			ms: Math.round(performance.now() - began),
			ok: false,
			code: typeof code === 'string' ? code : null,
			message: error instanceof Error ? error.message : String(error)
		});
		throw error;
	}
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const encode = (text: string) => new TextEncoder().encode(text);

function joined(parts: Uint8Array[]) {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.byteLength;
	}
	return out;
}

// out fills as each step finishes, so a refusal part-way still returns what ran before it
async function run(body: RunBody, out: Record<string, unknown>) {
	const steps: Record<string, unknown>[] = [];
	out.steps = steps;
	const { host, dialHost, landBase, site, ...rest } = body;
	const target: SshTarget = { ...rest, host };
	const partBytes = body.partBytes ?? PART_BYTES;
	const answers = [STAND_IN];
	const connectors = rigConnectors(dialHost, answers);

	const literal = await timed(steps, 'refusal.ip-literal', async () => {
		await openSession(connectors.survey, { ...target, host: '127.0.0.1' });
	}).then(
		() => 'connected',
		(error: { code?: string }) => error.code ?? 'error'
	);

	const mixed = await timed(steps, 'refusal.mixed-answers', async () => {
		await openSession(
			{ ...connectors.survey, resolve: async () => [STAND_IN, '10.0.0.5'] },
			target
		);
	}).then(
		() => 'connected',
		(error: { code?: string }) => error.code ?? 'error'
	);

	out.refusals = { literal, mixed };
	const survey = await timed(steps, 'survey', () =>
		createSshSurvey(connectors.survey, () => new Date()).run(target)
	);
	out.survey = survey;
	const dossier = dossierFor(survey, DEFAULT_RESTORE_CEILING_BYTES);
	out.dossier = dossier;
	const dialect = dossier.database;
	const privatePath = dossier.privateFiles;

	const { map, blobs } = memoryBlobs();
	const dumpPrefix = importKeys.dumpPrefix(ORG, OP);
	const dumpJob = {
		kind: 'database' as const,
		prefix: dumpPrefix,
		partBytes,
		structureOnly: CACHE_STRUCTURE_ONLY,
		dialect,
		maxBytes: DEFAULT_RESTORE_CEILING_BYTES * 2
	};
	const dumpStream = createDumpStream(connectors.stream, blobs);
	const dump = await timed(steps, 'dump', () => dumpStream.run(target, dumpJob));
	const firstKeys = keysUnder(map, dumpPrefix);

	const retry = await timed(steps, 'dump.retry', () => dumpStream.run(target, dumpJob));
	const retryKeys = keysUnder(map, dumpPrefix);
	out.dump = { parts: dump.parts, bytes: dump.bytes, keys: firstKeys };
	out.retry = {
		parts: retry.parts,
		bytes: retry.bytes,
		keys: retryKeys,
		sameKeys: JSON.stringify(firstKeys) === JSON.stringify(retryKeys)
	};

	let publicTar: { parts: number; bytes: number } | null = null;
	if ((survey.files.count ?? 0) > 0) {
		publicTar = await timed(steps, 'files.dump', () =>
			dumpStream.run(target, {
				kind: 'files',
				prefix: importKeys.filesPrefix(ORG, OP),
				partBytes,
				maxBytes: FILES_LIMIT_BYTES
			})
		);
		out.files = publicTar;
	}
	let privateTar: { parts: number; bytes: number } | null = null;
	if (privatePath !== null) {
		privateTar = await timed(steps, 'private.dump', () =>
			dumpStream.run(target, {
				kind: 'private',
				path: privatePath,
				prefix: importKeys.privatePrefix(ORG, OP),
				partBytes,
				maxBytes: FILES_LIMIT_BYTES
			})
		);
		out.private = privateTar;
	}

	const converter = createSqlConverter();
	const convertSteps: Record<string, unknown>[] = [];
	out.convertSteps = convertSteps;
	const dumpKey = (part: number) => importKeys.dump(ORG, OP, part);
	let sqlParts = 0;
	let sqlBytes = 0;
	let workflowSteps = 0;
	let lossy: string[] = [];
	const store = async (seq: number, bytes: Uint8Array) => {
		await blobs.put(importKeys.sql(ORG, OP, seq), bytes);
		sqlBytes += bytes.byteLength;
	};

	if (dialect === 'mysql') {
		let offset = 0;
		let seq = 0;
		while (offset < dump.bytes) {
			const began = performance.now();
			const window = await readWindow(
				blobs,
				dumpKey,
				partBytes,
				dump.bytes,
				offset,
				partBytes
			);
			const last = offset + window.byteLength >= dump.bytes;
			const chunk = await converter.convertChunk(window, last);
			if (chunk.cut <= 0) throw new Error('a conversion step made no progress');
			await store(seq, encode(chunk.sql));
			convertSteps.push({
				seq,
				ms: Math.round(performance.now() - began),
				inBytes: chunk.cut,
				outBytes: chunk.sql.length,
				rows: chunk.rows
			});
			offset += chunk.cut;
			seq++;
			workflowSteps++;
		}
		sqlParts = seq;
		workflowSteps++;
	} else {
		const cuts: number[] = [];
		const ddls: string[] = [];
		let offset = 0;
		while (offset < dump.bytes) {
			const began = performance.now();
			const window = await readWindow(
				blobs,
				dumpKey,
				partBytes,
				dump.bytes,
				offset,
				partBytes
			);
			const last = offset + window.byteLength >= dump.bytes;
			const scanned = await converter.scanPg(window, last);
			cuts.push(scanned.cut);
			ddls.push(scanned.ddl);
			convertSteps.push({
				pass: 'scan',
				seq: cuts.length - 1,
				ms: Math.round(performance.now() - began),
				inBytes: scanned.cut
			});
			offset += scanned.cut;
			workflowSteps++;
		}
		const began = performance.now();
		const ddl = ddls.join('\n');
		const schema = await converter.schemaPg(ddl);
		lossy = schema.lossy;
		await store(0, encode(schema.tables));
		convertSteps.push({
			pass: 'schema',
			ms: Math.round(performance.now() - began),
			outBytes: schema.tables.length
		});
		workflowSteps++;
		let at = 0;
		for (const [index, cut] of cuts.entries()) {
			const started = performance.now();
			const window = await readWindow(blobs, dumpKey, partBytes, dump.bytes, at, cut);
			const chunk = await converter.dataPg(window, ddl);
			await store(index + 1, encode(chunk.sql));
			convertSteps.push({
				pass: 'data',
				seq: index + 1,
				ms: Math.round(performance.now() - started),
				inBytes: cut,
				outBytes: chunk.sql.length,
				rows: chunk.rows
			});
			at += cut;
			workflowSteps++;
		}
		await store(cuts.length + 1, encode(schema.indexes));
		sqlParts = cuts.length + 2;
		workflowSteps++;
	}
	steps.push({
		step: 'convert',
		ms: convertSteps.reduce((sum, s) => sum + (s.ms as number), 0),
		ok: true,
		parts: sqlParts
	});

	const filesLinks: Record<string, unknown> = {};
	for (const [scheme, tar, keyOf] of [
		['public', publicTar, importKeys.files],
		['private', privateTar, importKeys.private]
	] as const) {
		if (tar === null) continue;
		const converted = await timed(steps, `${scheme}.convert`, async () => {
			const archive = await readWindow(
				blobs,
				(part) => keyOf(ORG, OP, part),
				partBytes,
				tar.bytes,
				0,
				tar.bytes
			);
			return convertFiles(archive, {
				nowMs: Date.now(),
				ceilingBytes: DEFAULT_RESTORE_CEILING_BYTES,
				databaseBytes: sqlBytes,
				scheme
			});
		});
		await store(sqlParts, converted.sql);
		sqlParts++;
		workflowSteps++;
		filesLinks[scheme] = {
			files: converted.files,
			bytes: converted.bytes,
			sqlBytes: converted.sql.length
		};
	}
	out.fileRows = filesLinks;

	const all: Uint8Array[] = [];
	for (let i = 0; i < sqlParts; i++) all.push((await blobs.get(importKeys.sql(ORG, OP, i)))!);
	const sqlAll = joined(all);
	out.convert = {
		dialect,
		parts: sqlParts,
		sqlBytes: sqlAll.byteLength,
		sha256: await sha256(sqlAll),
		restorable: restorable(sqlAll.byteLength, DEFAULT_RESTORE_CEILING_BYTES),
		lossy,
		workflowSteps:
			workflowSteps + 2 + (publicTar === null ? 0 : 1) + (privateTar === null ? 0 : 1)
	};

	if (landBase === undefined || site === undefined) {
		out.landing = 'not run';
		return out;
	}
	const landed = await timed(steps, 'land', async () => {
		const base = `${landBase}`;
		const label = `rig-${site}`;
		const posted = await fetch(`${base}/restore?label=${label}&site=${site}`, {
			method: 'POST',
			body: sqlAll as unknown as BodyInit
		});
		const text = await posted.text();
		if (posted.status !== 200) return { status: posted.status, answer: text.slice(0, 300) };
		const deadline = Date.now() + 120_000;
		for (;;) {
			const health = (await (await fetch(`${base}/health?site=${site}`)).json()) as {
				import?: { generation?: string; state?: string; error?: string };
			};
			if (health.import?.generation === label && health.import.state !== 'pending') {
				return { status: 200, answer: text.slice(0, 200), state: health.import.state };
			}
			if (Date.now() > deadline) return { status: 200, state: 'timeout' };
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	});
	out.landing = landed;
	return out;
}

export default {
	async fetch(request: Request): Promise<Response> {
		if (request.method !== 'POST') return new Response('post only', { status: 405 });
		const body = (await request.json()) as RunBody;
		const out: Record<string, unknown> = {};
		try {
			return Response.json(await run(body, out));
		} catch (error) {
			const code = (error as { code?: unknown }).code;
			return Response.json(
				{
					...out,
					error: error instanceof Error ? error.message : String(error),
					code: typeof code === 'string' ? code : null
				},
				{ status: 500 }
			);
		}
	}
};

import { createDumpStream } from '../../../../engine/src/adapters/dump-stream';
import {
	edgeportConnector,
	edgeportStreamConnector
} from '../../../../engine/src/adapters/edgeport-ssh';
import { createSqlConverter } from '../../../../engine/src/adapters/sql-converter';
import { openSession } from '../../../../engine/src/adapters/ssh-session';
import { createSshSurvey } from '../../../../engine/src/adapters/ssh-survey';
import { DEFAULT_RESTORE_CEILING_BYTES, restorable } from '../../../../engine/src/backup-parts';
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

// out fills as each step finishes, so a refusal part-way still returns what ran before it
async function run(body: RunBody, out: Record<string, unknown>) {
	const steps: Record<string, unknown>[] = [];
	out.steps = steps;
	const { host, dialHost, ...rest } = body;
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
	out.dossier = dossierFor(survey, DEFAULT_RESTORE_CEILING_BYTES);

	const { map, blobs } = memoryBlobs();
	const dumpPrefix = importKeys.dumpPrefix(ORG, OP);
	const dumpJob = {
		kind: 'database' as const,
		prefix: dumpPrefix,
		partBytes,
		structureOnly: CACHE_STRUCTURE_ONLY,
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

	if ((survey.files.count ?? 0) > 0) {
		const filesJob = {
			kind: 'files' as const,
			prefix: importKeys.filesPrefix(ORG, OP),
			partBytes,
			maxBytes: FILES_LIMIT_BYTES
		};
		const archive = await timed(steps, 'files.dump', () => dumpStream.run(target, filesJob));
		out.files = { parts: archive.parts, bytes: archive.bytes };
	}

	const converter = createSqlConverter();
	const convertSteps: Record<string, unknown>[] = [];
	out.convertSteps = convertSteps;
	let offset = 0;
	let seq = 0;
	let sqlBytes = 0;
	while (offset < dump.bytes) {
		const began = performance.now();
		const window = await readWindow(
			blobs,
			(part) => importKeys.dump(ORG, OP, part),
			partBytes,
			dump.bytes,
			offset,
			partBytes
		);
		const last = offset + window.byteLength >= dump.bytes;
		const chunk = await converter.convertChunk(window, last);
		if (chunk.cut <= 0) throw new Error('a conversion step made no progress');
		const sql = new TextEncoder().encode(chunk.sql);
		await blobs.put(importKeys.sql(ORG, OP, seq), sql);
		convertSteps.push({
			seq,
			ms: Math.round(performance.now() - began),
			inBytes: chunk.cut,
			outBytes: sql.byteLength,
			rows: chunk.rows,
			statements: chunk.statements
		});
		offset += chunk.cut;
		sqlBytes += sql.byteLength;
		seq++;
	}
	steps.push({
		step: 'convert',
		ms: convertSteps.reduce((sum, s) => sum + (s.ms as number), 0),
		ok: true,
		parts: seq
	});

	const sqlParts: Uint8Array[] = [];
	for (let i = 0; i < seq; i++) sqlParts.push((await blobs.get(importKeys.sql(ORG, OP, i)))!);
	const sqlAll = new Uint8Array(sqlBytes);
	let at = 0;
	for (const part of sqlParts) {
		sqlAll.set(part, at);
		at += part.byteLength;
	}

	out.convert = {
		parts: seq,
		sqlBytes,
		sha256: await sha256(sqlAll),
		restorable: restorable(sqlBytes, DEFAULT_RESTORE_CEILING_BYTES)
	};
	out.landing = 'not run';
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

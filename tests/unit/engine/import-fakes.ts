import type { D1Database } from '@cloudflare/workers-types';
import { toBase64Url } from '@contracts/common';
import { D1BackupLedger } from '../../../engine/src/adapters/backups';
import type { StreamChannel, StreamConnector } from '../../../engine/src/adapters/dump-stream';
import { createDumpStream } from '../../../engine/src/adapters/dump-stream';
import { createImportLander } from '../../../engine/src/adapters/import-lander';
import { importStoreOf } from '../../../engine/src/adapters/import-store';
import { backupWorkerOf } from '../../../engine/src/adapters/site';
import { createSqlConverter } from '../../../engine/src/adapters/sql-converter';
import {
	createSshSurvey,
	type SshConnectOptions,
	type SshConnector
} from '../../../engine/src/adapters/ssh-survey';
import type { ImportDeps } from '../../../engine/src/ports';
import { encryptRecord, loadKeyRing } from '../../../src/shared/custody/envelope';
import {
	IMPORT_CREDENTIAL_SQL,
	importCredentialAad
} from '../../../src/shared/custody/import-credentials';
import { fakeBlobs, fakeWorkers, MARKER } from './backup-fakes';
import type { World } from './fakes';

export const PRIVATE_KEY =
	'-----BEGIN PRIVATE KEY-----\nKEYBODY-d41d8cd98f00b204e9800998ecf8427e\n-----END PRIVATE KEY-----\n';
export const KEY_MARKER = 'KEYBODY-d41d8cd98f00b204e9800998ecf8427e';
export const SOURCE_HOST = 'source.example.test';
export const PUBLIC_IP = '93.184.216.34';
export const PRIVATE_IP = '10.0.0.7';

// answers each lookup from the list in turn and repeats the last one, so a name can be public
// on the first lookup and private on the second
export function lookups(...answers: string[][]) {
	const calls: string[] = [];
	const resolve = async (hostname: string) => {
		calls.push(hostname);
		return answers[Math.min(calls.length - 1, answers.length - 1)] ?? [];
	};
	return { resolve, calls };
}
export const SERVER_KEY = new TextEncoder().encode('server-host-key');
export const SERVER_FINGERPRINT = 'SHA256:server-host-key';
export const CREDENTIAL_ID = `imc_${'c'.repeat(26)}`;
export const ROOT = '/var/www/html';
export const DAY_MS = 24 * 60 * 60 * 1000;

const CREATE_NODE =
	'CREATE TABLE `node` (`nid` int(10) unsigned NOT NULL, `title` varchar(255) DEFAULT NULL, ' +
	'PRIMARY KEY (`nid`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;';

// a mysqldump-shaped dump: one table and a run of rows that carry a marker
export const mysqlDumpOf = (rows: number) =>
	`${CREATE_NODE}\n` +
	Array.from(
		{ length: rows },
		(_, n) => `INSERT INTO \`node\` VALUES (${n},'${MARKER}-${n}');\n`
	).join('');

// #region the connection

export interface StreamSession {
	options: SshConnectOptions;
	commands: string[];
	closed: boolean;
}

export interface FakeSource {
	dump: string;
	files: string;
	// bytes per stdout chunk
	chunk: number;
	exitCode: number;
	// fails the stream after this many chunks
	dropAfter: number | null;
	serverKey: Uint8Array;
	// the name lookups, in turn
	lookups: string[][];
}

export function fakeSource(patch: Partial<FakeSource> = {}) {
	const source: FakeSource = {
		dump: mysqlDumpOf(40),
		files: '',
		chunk: 37,
		exitCode: 0,
		dropAfter: null,
		serverKey: SERVER_KEY,
		lookups: [[PUBLIC_IP]],
		...patch
	};
	const sessions: StreamSession[] = [];
	const encode = (text: string) => new TextEncoder().encode(text);
	const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> => {
		let at = 0;
		let sent = 0;
		return new ReadableStream({
			pull(controller) {
				if (source.dropAfter !== null && sent >= source.dropAfter) {
					controller.error(new Error('channel reset'));
					return;
				}
				if (at >= bytes.length) {
					controller.close();
					return;
				}
				controller.enqueue(bytes.slice(at, at + source.chunk));
				at += source.chunk;
				sent++;
			}
		});
	};
	const names = lookups(...source.lookups);
	const connector: StreamConnector = {
		resolve: names.resolve,
		async fingerprint(key) {
			return `SHA256:${new TextDecoder().decode(key)}`;
		},
		async connect(options) {
			const record: StreamSession = { options, commands: [], closed: false };
			sessions.push(record);
			if (!(await options.hostKey.verify('ssh-ed25519', source.serverKey))) {
				throw new Error('host key rejected');
			}
			return {
				async stream(command): Promise<StreamChannel> {
					record.commands.push(command);
					const body = command.includes('drush sql:dump') ? source.dump : source.files;
					return {
						stdout: streamOf(encode(body)),
						stderr: new ReadableStream({
							start(controller) {
								controller.enqueue(encode(`server said ${KEY_MARKER}`));
								controller.close();
							}
						}),
						exit: Promise.resolve({ code: source.exitCode })
					};
				},
				async close() {
					record.closed = true;
				}
			};
		}
	};
	return { source, connector, sessions, lookups: names };
}

const SURVEY_ANSWERS = (command: string): string | null => {
	if (command === 'php -v') return 'PHP 8.3.6 (cli) (built: Jan 1 2026)\n';
	if (command.includes('status --format=json')) {
		return JSON.stringify({
			'drupal-version': '11.4.8',
			'db-driver': 'mysql',
			'db-name': 'site',
			uri: 'http://site.example',
			root: ROOT
		});
	}
	if (command.includes('pm:list')) return '["node","system"]';
	if (command.startsWith('du -sk')) return `2048\t${ROOT}/sites/default/files\n`;
	if (command.includes('-type f | wc -l')) return '0\n';
	if (command.includes('information_schema')) return '123456\n';
	if (command.includes('SELECT 1')) return '1\n';
	if (command.includes('file_managed')) return '0\n';
	if (command.includes('FROM node')) return '12\n';
	return null;
};

export function fakeSurveyConnector(
	failWith: Error | null = null,
	answers: string[][] = [[PUBLIC_IP]]
) {
	const sessions: StreamSession[] = [];
	const names = lookups(...answers);
	const connector: SshConnector = {
		resolve: names.resolve,
		async fingerprint(key) {
			return `SHA256:${new TextDecoder().decode(key)}`;
		},
		async connect(options) {
			const record: StreamSession = { options, commands: [], closed: false };
			sessions.push(record);
			if (failWith !== null) throw failWith;
			if (!(await options.hostKey.verify('ssh-ed25519', SERVER_KEY))) {
				throw new Error('host key rejected');
			}
			return {
				async exec(command) {
					record.commands.push(command);
					const out = SURVEY_ANSWERS(command);
					return { code: out === null ? 1 : 0, stdoutText: out ?? '', stderrText: '' };
				},
				async close() {
					record.closed = true;
				}
			};
		}
	};
	return { connector, sessions, lookups: names, survey: createSshSurvey(connector) };
}

// #endregion

// #region the credential row

export const KEK = { KEK_V1: toBase64Url(new Uint8Array(32).fill(7)) };

export interface SealOptions {
	id?: string;
	orgId: string;
	fingerprint?: string | null;
	expiresAt?: number;
	now: number;
}

// writes the row the dashboard route writes, with the same statement and the same sealing
export async function sealCredential(world: World, options: SealOptions): Promise<string> {
	const id = options.id ?? CREDENTIAL_ID;
	const ring = await loadKeyRing(KEK);
	const envelope = await encryptRecord(PRIVATE_KEY, importCredentialAad(id), ring);
	world.sqlite
		.prepare(IMPORT_CREDENTIAL_SQL.insert)
		.run(
			id,
			options.orgId,
			'usr_x',
			JSON.stringify(envelope),
			'ssh-ed25519 AAAA drupflare-import',
			SOURCE_HOST,
			22,
			'deploy',
			options.now,
			options.expiresAt ?? options.now + DAY_MS
		);
	const fingerprint =
		options.fingerprint === undefined ? SERVER_FINGERPRINT : options.fingerprint;
	if (fingerprint !== null) {
		world.sqlite
			.prepare(IMPORT_CREDENTIAL_SQL.confirmHostKey)
			.run(fingerprint, 'ssh-ed25519', options.orgId, id);
	}
	return id;
}

export const credentialRows = (world: World) =>
	world.sqlite.prepare('SELECT id, used_at FROM import_credentials').all();

// #endregion

// #region the deps

export function importDepsOf(
	world: World,
	parts: {
		connector: StreamConnector;
		survey?: SshConnector;
		log?: string[];
	}
) {
	const log = parts.log ?? [];
	const db = (world.ledger as unknown as { db: D1Database }).db;
	const worker = fakeWorkers(log);
	const blobs = fakeBlobs();
	const workerPort = backupWorkerOf(worker.fetcher, 1_000);
	const deps: ImportDeps = {
		...world.deps,
		worker: workerPort,
		blobs: blobs.blobs,
		backups: new D1BackupLedger(db),
		sleep: async (ms) => {
			world.clock.advance(ms);
			worker.alarm();
		},
		imports: importStoreOf({ db, secrets: KEK, now: world.clock.now }),
		survey: createSshSurvey(parts.survey ?? fakeSurveyConnector().connector),
		dump: createDumpStream(parts.connector, blobs.blobs),
		converter: createSqlConverter(),
		lander: createImportLander({ custody: world.deps.custody, worker: workerPort })
	};
	return { deps, worker, blobs, log };
}

// #endregion

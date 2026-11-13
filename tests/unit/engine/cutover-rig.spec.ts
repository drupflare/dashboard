import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCutoverSource } from '../../../engine/src/adapters/cutover-source';
import { manifestOfMarker, readCopy } from '../../../engine/src/adapters/cutover-store';
import { createDumpStream, type StreamConnector } from '../../../engine/src/adapters/dump-stream';
import { createSqlConverter } from '../../../engine/src/adapters/sql-converter';
import type { SshConnector } from '../../../engine/src/adapters/ssh-survey';
import type { ImportStore } from '../../../engine/src/ports';
import { fakeBlobs } from './backup-fakes';
import { CREDENTIAL_ID } from './import-fakes';

const RIG = process.env.INTEGRATION === '1';
const COMPOSE = join(__dirname, '../../rigs/cutover/compose.yml');
const ROOT = '/opt/drupal/web';
const ORG = `org_${'o'.repeat(26)}`;
const OP = `op_${'r'.repeat(26)}`;
const RUN = Date.now().toString(36);
const key = (label: string) => `${OP}:${label}`;

interface Rig {
	sshPort: string;
	webPort: string;
	keyFile: string;
}

let rig: Rig;
let started: { dir: string } | null = null;

// an already running stack is used when its ports and key are given; otherwise one is started
async function bringUp(): Promise<Rig> {
	const given = process.env.CUTOVER_RIG_KEY;
	if (given !== undefined) {
		return {
			sshPort: process.env.CUTOVER_RIG_SSH_PORT ?? '2232',
			webPort: process.env.CUTOVER_RIG_WEB_PORT ?? '8190',
			keyFile: given
		};
	}
	const dir = mkdtempSync(join(tmpdir(), 'cutover-rig-'));
	const keyFile = join(dir, 'id');
	execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', keyFile]);
	const env = {
		...process.env,
		CUTOVER_RIG_PUBKEY: readFileSync(`${keyFile}.pub`, 'utf8').trim(),
		CUTOVER_RIG_SSH_PORT: '2232',
		CUTOVER_RIG_WEB_PORT: '8190'
	};
	execFileSync(
		'docker',
		['compose', '-f', COMPOSE, 'up', '-d', '--wait', '--wait-timeout', '900'],
		{
			env,
			stdio: 'ignore'
		}
	);
	started = { dir };
	return { sshPort: '2232', webPort: '8190', keyFile };
}

const sshArgs = (r: Rig) => [
	'-i',
	r.keyFile,
	'-p',
	r.sshPort,
	'-o',
	'StrictHostKeyChecking=no',
	'-o',
	'UserKnownHostsFile=/dev/null',
	'-o',
	'BatchMode=yes',
	'-o',
	'LogLevel=ERROR',
	'tester@127.0.0.1'
];

const fingerprintOf = (blob: Uint8Array) =>
	`SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;

const hostKeys = new Map<string, Uint8Array>();

function hostKeyOf(r: Rig): Uint8Array {
	const known = hostKeys.get(r.sshPort);
	if (known !== undefined) return known;
	const scan = execFileSync('ssh-keyscan', ['-p', r.sshPort, '-t', 'ed25519', '127.0.0.1'], {
		stdio: ['ignore', 'pipe', 'ignore']
	}).toString();
	const line = scan.split('\n').find((entry) => entry.includes('ssh-ed25519'))!;
	const blob = Buffer.from(line.split(' ')[2]!, 'base64');
	hostKeys.set(r.sshPort, blob);
	return blob;
}

// the system ssh client stands in for edgeport; the address check sees a public address and the
// connection goes to the mapped local port
function connectorOf(r: Rig): SshConnector & StreamConnector {
	const session = {
		// ssh exits 255 when the transport failed, which sshd does under a burst of logins; a real
		// connector throws there, so this does too, after a few tries
		async exec(command: string) {
			for (let attempt = 1; ; attempt++) {
				const result = await new Promise<{
					code: number;
					stdoutText: string;
					stderrText: string;
				}>((resolve) => {
					execFile(
						'ssh',
						[...sshArgs(r), command],
						{ maxBuffer: 64 * 1024 * 1024 },
						(error, stdout, stderr) =>
							resolve({
								code:
									error === null
										? 0
										: typeof error.code === 'number'
											? error.code
											: 1,
								stdoutText: stdout,
								stderrText: stderr
							})
					);
				});
				if (result.code !== 255) return result;
				if (attempt >= 5) throw new Error('the connection to the server failed');
				await new Promise((resolve) => setTimeout(resolve, 1_000));
			}
		},
		async stream(command: string) {
			const child = spawn('ssh', [...sshArgs(r), command]);
			return {
				stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
				stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
				exit: new Promise<{ code: number | null }>((resolve) =>
					child.on('close', (code) => resolve({ code }))
				)
			};
		},
		async close() {}
	};
	return {
		resolve: async () => ['93.184.216.34'],
		fingerprint: async (blob) => fingerprintOf(blob),
		async connect(options) {
			const blob = hostKeyOf(r);
			if (!(await options.hostKey.verify('ssh-ed25519', blob))) {
				throw new Error('host key rejected');
			}
			return session;
		}
	};
}

const onServer = (r: Rig, command: string) =>
	execFileSync('ssh', [...sshArgs(r), `cd ${ROOT} && ${command}`])
		.toString()
		.trim();

const rowCount = (r: Rig, name: string) =>
	Number(
		onServer(r, `drush sql:query "SELECT COUNT(*) FROM users_field_data WHERE name='${name}'"`)
	);

// a visitor registering an account, which is a write the site accepts without a login
async function visitorWrite(r: Rig, name: string, form?: string): Promise<number> {
	const base = `http://127.0.0.1:${r.webPort}`;
	let buildId = form;
	if (buildId === undefined) {
		const page = await (await fetch(`${base}/user/register`)).text();
		buildId = /name="form_build_id" value="([^"]+)"/.exec(page)?.[1];
	}
	const response = await fetch(`${base}/user/register`, {
		method: 'POST',
		redirect: 'manual',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			name,
			mail: `${name}@example.test`,
			form_build_id: buildId ?? '',
			form_id: 'user_register_form',
			op: 'Create new account'
		})
	});
	return response.status;
}

async function formBuildId(r: Rig): Promise<string> {
	const page = await (await fetch(`http://127.0.0.1:${r.webPort}/user/register`)).text();
	return /name="form_build_id" value="([^"]+)"/.exec(page)![1]!;
}

function worldOf(r: Rig, partBytes = 8 * 1024 * 1024) {
	const store = fakeBlobs();
	const connector = connectorOf(r);
	const target = {
		host: 'source.example.test',
		port: 22,
		user: 'tester',
		privateKey: 'not-used-by-the-system-client',
		expectedFingerprint: fingerprintOf(hostKeyOf(r)),
		root: ROOT
	};
	const imports: ImportStore = {
		withTarget: async (_credentialId, _orgId, root, use) => use({ ...target, root }),
		discard: async () => {},
		markImported: async () => {},
		beginRun: async (_operationId, _orgId, at) => at,
		endRun: async () => {}
	};
	const source = createCutoverSource(
		{
			imports,
			connector,
			dump: createDumpStream(connector, store.blobs),
			converter: createSqlConverter(),
			blobs: store.blobs,
			dns: { lookup: async () => ({ ttl: 300, names: [], addresses: ['93.184.216.34'] }) },
			now: Date.now,
			partBytes
		},
		`${CREDENTIAL_ID}${ROOT}`,
		ORG
	);
	return { store, source };
}

describe.skipIf(!RIG)('the cutover source against the docker distro', () => {
	beforeAll(async () => {
		rig = await bringUp();
		// the standard profile takes no sign-ups, and a sign-up is the visitor write this rig makes
		onServer(rig, 'drush config:set -y user.settings register visitors');
		onServer(rig, 'drush state:delete system.maintenance_mode');
	}, 1_000_000);

	afterAll(() => {
		if (started === null) return;
		execFileSync('docker', ['compose', '-f', COMPOSE, 'down', '-v'], { stdio: 'ignore' });
		rmSync(started.dir, { recursive: true, force: true });
	}, 120_000);

	it.each(['freeze', 'delta'] as const)(
		'takes writes before the freeze through the final delta and refuses them after it under %s',
		async (policy) => {
			const { store, source } = worldOf(rig);
			const before = `before_${policy}_${RUN}`;
			const during = `during_${policy}_${RUN}`;
			const after = `after_${policy}_${RUN}`;
			const op = (label: string) => `${OP}-${policy}:${label}`;
			const manifestOp = `${OP}-${policy}`;

			const snapshot = await source.snapshot(op('snapshot'));
			const capture = await source.delta(op('capture-delta'), snapshot.marker);
			expect(snapshot.marker).toMatch(/^snapshot:[0-9a-f]{16}$/);

			// a write that arrives after the snapshot and the first delta, before the freeze
			expect(await visitorWrite(rig, before)).toBeLessThan(400);
			expect(rowCount(rig, before)).toBe(1);
			const staleForm = await formBuildId(rig);

			await source.applyWritePolicy(op('apply-write-policy'), policy);
			expect(onServer(rig, 'drush state:get system.maintenance_mode')).toBe('1');
			// a write during the window is refused by the policy
			expect(await visitorWrite(rig, during, staleForm)).toBe(503);
			expect(rowCount(rig, during)).toBe(0);

			const final = await source.delta(op('final-delta'), capture.marker);
			const sql = await textOfOp(store, manifestOp, final.marker);
			expect(sql).toContain(before);
			expect(sql).not.toContain(during);
			expect(sql).toContain('sequences');
			expect(await textOfOp(store, manifestOp, snapshot.marker)).not.toContain(before);
			expect(await textOfOp(store, manifestOp, capture.marker)).not.toContain(before);

			await source.restoreWrites(op('restore-writes'));
			expect(onServer(rig, 'drush state:get system.maintenance_mode')).toBe('');
			await source.restoreWrites(op('restore-writes'));
			expect(await visitorWrite(rig, after)).toBeLessThan(400);
			expect(rowCount(rig, after)).toBe(1);
		},
		600_000
	);

	it('refuses read only on a site without the module and leaves its writes open', async () => {
		const { source } = worldOf(rig);
		await expect(
			source.applyWritePolicy(`${OP}-ro:apply-write-policy`, 'read-only')
		).rejects.toMatchObject({ code: 'read_only_unavailable' });
		expect(onServer(rig, 'drush state:get system.maintenance_mode')).toBe('');
		expect(await visitorWrite(rig, `after_read_only_${RUN}`)).toBeLessThan(400);
	}, 120_000);

	it('answers a repeat of the snapshot from its manifest', async () => {
		const { store, source } = worldOf(rig);
		const first = await source.snapshot(`${OP}-again:snapshot`);
		const parts = [...store.objects.keys()].length;
		expect(await source.snapshot(`${OP}-again:snapshot`)).toEqual(first);
		expect([...store.objects.keys()].length).toBe(parts);
	}, 300_000);
});

async function textOfOp(store: ReturnType<typeof fakeBlobs>, operationId: string, marker: string) {
	const found = (await manifestOfMarker(store.blobs, ORG, operationId, marker))!;
	return new TextDecoder().decode((await readCopy(store.blobs, found.copy, found.manifest))!);
}

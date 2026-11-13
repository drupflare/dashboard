// Runs the import pipeline against the docker distro on this machine.
// Gated: INTEGRATION=1 npx tsx tests/rigs/import-docker.ts
// Needs docker, the drangler checkout at ../drangler (for the reference survey) and the loopback ports
// 2222 (ssh), 8180 (http) and 33306 (db). Nothing leaves localhost except the distro's own apt and
// composer fetches while it first boots.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject
} from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.env.INTEGRATION !== '1') {
	console.log('import-docker: skipped, set INTEGRATION=1 to run');
	process.exit(0);
}

const RIG = resolve(import.meta.dirname, '../../scripts/spikes/import-rig');
const COMPOSE = [
	'compose',
	'-p',
	'import-rig',
	'-f',
	join(RIG, 'docker/compose.yml'),
	'-f',
	join(RIG, 'docker/caps.yml')
];
const DRANGLER_CLI = resolve(import.meta.dirname, '../../../drangler/dist/cli.js');
const SSH_PORT = 2222;
const ROOT = '/opt/drupal/web';
const WORKER = 'http://127.0.0.1:8799/';

const work = process.env.RIG_WORK_DIR ?? mkdtempSync(join(tmpdir(), 'import-rig-'));

// #region keys

// the key is generated for this run unless RIG_KEY_FILE names a PKCS8 PEM; it is never printed
function loadKey(): KeyObject {
	const file = process.env.RIG_KEY_FILE;
	if (file) return createPrivateKey(readFileSync(file, 'utf8'));
	return generateKeyPairSync('ed25519').privateKey;
}

const sshString = (bytes: Buffer) => {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(bytes.length);
	return Buffer.concat([length, bytes]);
};

function openSshKeys(privateKey: KeyObject) {
	const pub = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32);
	const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
	const algorithm = Buffer.from('ssh-ed25519');
	const publicBlob = Buffer.concat([sshString(algorithm), sshString(pub)]);
	const check = Buffer.from([1, 2, 3, 4]);
	const body = Buffer.concat([
		check,
		check,
		sshString(algorithm),
		sshString(pub),
		sshString(Buffer.concat([seed, pub])),
		sshString(Buffer.alloc(0))
	]);
	const padded = Buffer.concat([
		body,
		Buffer.from(Array.from({ length: (8 - (body.length % 8)) % 8 }, (_, i) => i + 1))
	]);
	const blob = Buffer.concat([
		Buffer.from('openssh-key-v1\0'),
		sshString(Buffer.from('none')),
		sshString(Buffer.from('none')),
		sshString(Buffer.alloc(0)),
		Buffer.from([0, 0, 0, 1]),
		sshString(publicBlob),
		sshString(padded)
	]);
	const wrapped = blob
		.toString('base64')
		.match(/.{1,70}/g)!
		.join('\n');
	return {
		publicLine: `ssh-ed25519 ${publicBlob.toString('base64')} drupflare-import-rig`,
		privatePem: `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`
	};
}

// #endregion

function sh(args: string[], env: NodeJS.ProcessEnv = process.env) {
	return spawnSync('docker', args, { env, encoding: 'utf8', timeout: 1_200_000 });
}

function startWorker(): Promise<ChildProcess> {
	const child = spawn(
		join(import.meta.dirname, '../../node_modules/.bin/wrangler'),
		['dev', '--local', '--ip', '127.0.0.1', '--port', '8799', '--config', 'wrangler.jsonc'],
		{ cwd: RIG, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } }
	);
	return new Promise((ok, fail) => {
		let seen = '';
		const onData = (chunk: Buffer) => {
			seen += chunk.toString();
			if (seen.includes('Ready on')) ok(child);
		};
		child.stdout.on('data', onData);
		child.stderr.on('data', onData);
		child.on('exit', (code) => fail(new Error(`wrangler exited ${code} before it was ready`)));
		setTimeout(() => fail(new Error('wrangler was not ready in 120 s')), 120_000);
	});
}

interface Body {
	host: string;
	port: number;
	user: string;
	privateKey: string;
	expectedFingerprint: string;
	root: string;
	partBytes?: number;
}

async function runWorker(body: Body) {
	const began = performance.now();
	const response = await fetch(WORKER, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ ...body, dialHost: '127.0.0.1' }),
		signal: AbortSignal.timeout(600_000)
	});
	const text = await response.text();
	return {
		status: response.status,
		wallMs: Math.round(performance.now() - began),
		keyEchoed: text.includes('PRIVATE KEY'),
		result: JSON.parse(text) as Record<string, any>
	};
}

const summary: Record<string, unknown> = {};

async function main() {
	const key = loadKey();
	const keys = openSshKeys(key);
	const pemPath = join(work, 'identity');
	writeFileSync(pemPath, keys.privatePem, { mode: 0o600 });
	const pkcs8 = key.export({ type: 'pkcs8', format: 'pem' }).toString();

	const up = sh([...COMPOSE, 'up', '-d', '--wait', '--wait-timeout', '900'], {
		...process.env,
		DRANGLER_E2E_SSH_PUBKEY: keys.publicLine
	});
	summary.compose = {
		status: up.status,
		lastLine: (up.stderr.trim().split('\n').pop() ?? '').slice(0, 120)
	};
	if (up.status !== 0) throw new Error('docker compose up failed');

	const fingerprintLine = spawnSync(
		'sh',
		['-c', `ssh-keyscan -p ${SSH_PORT} -t ed25519 127.0.0.1 2>/dev/null | ssh-keygen -lf -`],
		{ encoding: 'utf8' }
	);
	const fingerprint = fingerprintLine.stdout.split(' ')[1];
	if (!fingerprint) throw new Error('ssh-keyscan returned no host key');

	const worker = await startWorker();
	try {
		const base = {
			host: 'rig.example',
			port: SSH_PORT,
			user: 'tester',
			privateKey: pkcs8,
			root: ROOT
		};
		summary.hostKeyPin = await runWorker({ ...base, expectedFingerprint: 'SHA256:wrong' });
		summary.pipeline = await runWorker({ ...base, expectedFingerprint: fingerprint });
		summary.multiPart = await runWorker({
			...base,
			expectedFingerprint: fingerprint,
			partBytes: 1_048_576
		});

		const reference = join(work, 'survey.json');
		// drangler runs the ssh on PATH with accept-new against the user's known_hosts, which still holds
		// the key of an earlier container; this wrapper points ssh at a file in the work dir instead
		mkdirSync(join(work, 'bin'), { recursive: true });
		const sshWrapper = join(work, 'bin', 'ssh');
		writeFileSync(
			sshWrapper,
			`#!/bin/sh\nexec /usr/bin/ssh -o UserKnownHostsFile=${join(work, 'known_hosts')} "$@"\n`,
			{ mode: 0o755 }
		);
		const referenceBegan = performance.now();
		const drangler = spawnSync(
			process.execPath,
			[
				DRANGLER_CLI,
				'migrate',
				'survey',
				'--host',
				`tester@127.0.0.1:${SSH_PORT}`,
				'--root',
				ROOT,
				'--identity',
				join(work, 'identity'),
				'--out',
				reference
			],
			{
				env: { ...process.env, PATH: `${join(work, 'bin')}:${process.env.PATH}` },
				encoding: 'utf8',
				timeout: 600_000
			}
		);
		summary.reference = {
			status: drangler.status,
			wallMs: Math.round(performance.now() - referenceBegan),
			stderrTail: (drangler.stderr ?? '')
				.trim()
				.split('\n')
				.slice(-3)
				.join(' | ')
				.slice(0, 400)
		};
		if (drangler.status === 0) {
			const ref = JSON.parse(readFileSync(reference, 'utf8'));
			summary.referenceDiff = diffSurvey(
				ref,
				summary.pipeline as { result: Record<string, any> }
			);
		}
	} finally {
		worker.kill();
	}
	console.log(
		JSON.stringify(
			summary,
			(_k, v) => (typeof v === 'string' && v.includes('PRIVATE KEY') ? '[redacted]' : v),
			2
		)
	);
}

// the owner-facing host name and the capture time differ by design, so they are left out of the comparison
function diffSurvey(ref: Record<string, any>, pipeline: { result: Record<string, any> }) {
	const mine = pipeline.result.survey as Record<string, any> | undefined;
	if (!mine) return { comparable: false };
	const skip = new Set(['capturedAt', 'host']);
	const differs: string[] = [];
	const walk = (a: any, b: any, path: string) => {
		if (JSON.stringify(a) === JSON.stringify(b)) return;
		if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
			for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
				if (skip.has(k) && path === '') continue;
				walk(a[k], b[k], path ? `${path}.${k}` : k);
			}
			return;
		}
		const show = (v: unknown) => JSON.stringify(v)?.slice(0, 80);
		differs.push(`${path || '(root)'}: reference ${show(a)} | worker ${show(b)}`);
	};
	walk(ref, mine, '');
	return { comparable: true, differs };
}

main()
	.catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	})
	.finally(() => {
		if (process.env.RIG_KEEP !== '1') sh([...COMPOSE, 'down', '-v']);
		if (!process.env.RIG_WORK_DIR) rmSync(work, { recursive: true, force: true });
	});

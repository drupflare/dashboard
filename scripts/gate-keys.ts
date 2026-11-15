import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { signingKeyFromSeed, toBase64Url } from '../contracts/src/common';

const USAGE = `usage: bun scripts/gate-keys.ts --out <private key file>

Makes an Ed25519 key pair for the Gate. The public key goes to stdout; set it as GATE_PUBLIC_KEY on
the dispatch Worker. The private key (a 32 byte seed, base64url) goes to --out with mode 0600 and
is never printed; it is the Gate's signing secret. An existing file is not overwritten.`;

export async function generateGateKeys(): Promise<{ publicKey: string; privateKey: string }> {
	const seed = crypto.getRandomValues(new Uint8Array(32));
	const { publicKey } = await signingKeyFromSeed(seed);
	return { publicKey, privateKey: toBase64Url(seed) };
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export async function run(
	argv: string[],
	write: (path: string, data: string) => void = (path, data) =>
		writeFileSync(path, data, { flag: 'wx', mode: 0o600 })
): Promise<RunResult> {
	let out: string | undefined;
	try {
		({
			values: { out }
		} = parseArgs({ args: argv, options: { out: { type: 'string' } }, strict: true }));
	} catch (error) {
		return { code: 2, stdout: '', stderr: `${(error as Error).message}\n${USAGE}\n` };
	}
	if (out === undefined || out === '') return { code: 2, stdout: '', stderr: `${USAGE}\n` };
	const keys = await generateGateKeys();
	try {
		write(out, `${keys.privateKey}\n`);
	} catch (error) {
		return {
			code: 1,
			stdout: '',
			stderr: `could not write ${out}: ${(error as Error).message}\n`
		};
	}
	return { code: 0, stdout: `${keys.publicKey}\n`, stderr: '' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const result = await run(process.argv.slice(2));
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	process.exit(result.code);
}

import { classifySshError } from '../../../engine/src/adapters/ssh-errors';
import {
	CONNECT_TIMEOUT_MS,
	type SshConnectOptions
} from '../../../engine/src/adapters/ssh-session';
import { ApiError } from '../../shared/errors';

export interface Keypair {
	privateKeyPem: string;
	// the line the owner adds to authorized_keys
	publicKey: string;
}

export interface HostKey {
	type: string;
	fingerprint: string;
}

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

function sshString(bytes: Uint8Array): Uint8Array {
	const out = new Uint8Array(4 + bytes.length);
	new DataView(out.buffer).setUint32(0, bytes.length);
	out.set(bytes, 4);
	return out;
}

export const PUBLIC_KEY_COMMENT = 'drupflare-import';

// an Ed25519 pair: the private half as PKCS8 PEM, the public half as an OpenSSH line
export async function generateKeypair(): Promise<Keypair> {
	const pair = (await crypto.subtle.generateKey('Ed25519', true, [
		'sign',
		'verify'
	])) as CryptoKeyPair;
	const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
	const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
	const body = base64(pkcs8).replace(/(.{64})/g, '$1\n');
	const blob = new Uint8Array([
		...sshString(new TextEncoder().encode('ssh-ed25519')),
		...sshString(raw)
	]);
	return {
		privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
		publicKey: `ssh-ed25519 ${base64(blob)} ${PUBLIC_KEY_COMMENT}`
	};
}

export interface ProbeConnector {
	connect(options: SshConnectOptions): Promise<{ close(): Promise<void> }>;
	fingerprint(key: Uint8Array): Promise<string>;
}

// the handshake presents the host key before any key is offered, so refusing it there ends the
// connection with no login and no command; a throwaway key fills the option the library needs
export async function probeHostKey(
	connector: ProbeConnector,
	target: { host: string; port: number }
): Promise<HostKey> {
	const { privateKeyPem } = await generateKeypair();
	let seen = null as HostKey | null;
	try {
		const session = await connector.connect({
			hostname: target.host,
			port: target.port,
			username: 'probe',
			privateKey: { pem: privateKeyPem },
			timeoutMs: CONNECT_TIMEOUT_MS,
			hostKey: {
				async verify(type, key) {
					seen = { type, fingerprint: await connector.fingerprint(key) };
					return false;
				}
			}
		});
		await session.close().catch(() => undefined);
	} catch (error) {
		if (seen === null) {
			const { code, message } = classifySshError(error);
			throw new ApiError('unprocessable', message, { reason: `probe_${code}` });
		}
	}
	if (seen === null) {
		throw new ApiError('unprocessable', 'The server did not present a host key.', {
			reason: 'probe_no_host_key'
		});
	}
	return seen;
}

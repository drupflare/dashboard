import { describe, expect, it } from 'vitest';
import {
	generateKeypair,
	probeHostKey,
	PUBLIC_KEY_COMMENT,
	type ProbeConnector
} from '../../../../src/server/integrations/ssh-key';

const SERVER_KEY = new TextEncoder().encode('server-host-key');

function connector(behaviour: {
	present?: boolean;
	failWith?: Error;
	acceptKey?: boolean;
}): ProbeConnector & { calls: { username: string; hostname: string; port: number }[] } {
	const calls: { username: string; hostname: string; port: number }[] = [];
	return {
		calls,
		async fingerprint(key) {
			return `SHA256:${new TextDecoder().decode(key)}`;
		},
		async connect(options) {
			calls.push({
				username: options.username,
				hostname: options.hostname,
				port: options.port
			});
			if (behaviour.present !== false) {
				const accepted = await options.hostKey.verify('ssh-ed25519', SERVER_KEY);
				if (behaviour.acceptKey === true && accepted) return { close: async () => {} };
				if (!accepted) throw new Error('host key rejected');
			}
			if (behaviour.failWith !== undefined) throw behaviour.failWith;
			return { close: async () => {} };
		}
	};
}

describe('generateKeypair', () => {
	it('makes a PKCS8 Ed25519 private key and an OpenSSH public line', async () => {
		const pair = await generateKeypair();
		expect(pair.privateKeyPem).toMatch(
			/^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PRIVATE KEY-----\n$/
		);
		expect(pair.publicKey).toMatch(
			new RegExp(`^ssh-ed25519 [A-Za-z0-9+/]+=* ${PUBLIC_KEY_COMMENT}$`)
		);
		const blob = Uint8Array.from(atob(pair.publicKey.split(' ')[1]!), (c) => c.charCodeAt(0));
		const view = new DataView(blob.buffer);
		expect(view.getUint32(0)).toBe(11);
		expect(new TextDecoder().decode(blob.slice(4, 15))).toBe('ssh-ed25519');
		expect(view.getUint32(15)).toBe(32);
		expect(blob.length).toBe(4 + 11 + 4 + 32);
	});

	it('imports back as a signing key and makes a different pair each time', async () => {
		const one = await generateKeypair();
		const two = await generateKeypair();
		expect(one.publicKey).not.toBe(two.publicKey);
		const der = Uint8Array.from(
			atob(one.privateKeyPem.replace(/-----[A-Z ]+-----|\n/g, '')),
			(c) => c.charCodeAt(0)
		);
		await expect(
			crypto.subtle.importKey('pkcs8', der, 'Ed25519', false, ['sign'])
		).resolves.toBeDefined();
	});
});

describe('probeHostKey', () => {
	it('reads the type and fingerprint and refuses the key, so no login is attempted', async () => {
		const fake = connector({});
		const seen = await probeHostKey(fake, { host: 'server.example.test', port: 2222 });
		expect(seen).toEqual({ type: 'ssh-ed25519', fingerprint: 'SHA256:server-host-key' });
		expect(fake.calls).toEqual([
			{ username: 'probe', hostname: 'server.example.test', port: 2222 }
		]);
	});

	it('names an unreachable server with a plain reason', async () => {
		const fake = connector({
			present: false,
			failWith: new Error('connect ECONNREFUSED 1.2.3.4')
		});
		const error = await probeHostKey(fake, { host: 'a.example', port: 22 }).catch(
			(caught: unknown) => caught
		);
		expect(error).toMatchObject({
			code: 'unprocessable',
			details: { reason: 'probe_refused' }
		});
		expect((error as Error).message).not.toContain('1.2.3.4');
	});

	it('refuses a server that never presents a host key', async () => {
		const fake = connector({ present: false });
		const error = await probeHostKey(fake, { host: 'a.example', port: 22 }).catch(
			(caught: unknown) => caught
		);
		expect(error).toMatchObject({ details: { reason: 'probe_no_host_key' } });
	});
});

import { publicAddressOf } from '../../../src/server/integrations/ssh-host';
import type { Resolver } from '../../../src/server/integrations/url-guard';
import type { SshTarget } from '../ports';
import { PermanentError } from '../step';
import {
	connectionRefusal,
	HOST_KEY_MISMATCH_MESSAGE,
	HOST_PRIVATE_MESSAGE,
	HOST_UNRESOLVED_MESSAGE
} from './ssh-errors';

export interface SshConnectOptions {
	hostname: string;
	port: number;
	username: string;
	privateKey: { pem: string };
	timeoutMs: number;
	// returns whether the server key is the one the owner confirmed
	hostKey: { verify(keyType: string, key: Uint8Array): Promise<boolean> };
}

export const CONNECT_TIMEOUT_MS = 15_000;

// the host key is checked inside the handshake, so a mismatch ends the connection before the
// first command; the key is held in the options for this one call
export async function openSession<S>(
	connector: {
		connect(options: SshConnectOptions): Promise<S>;
		fingerprint(key: Uint8Array): Promise<string>;
		// the name lookup the address check uses; a connector owns the network, so it owns this too
		resolve: Resolver;
	},
	target: SshTarget
): Promise<S> {
	// the name is resolved and checked now, at the moment of connecting, and the connection goes to
	// the address that passed, so a name that changed since the owner set it up cannot reach a
	// private address; the pinned host key still decides whether the server is the right one
	const dial = await publicAddressOf(target.host, connector.resolve);
	if (!dial.ok) {
		throw dial.reason === 'host_private'
			? new PermanentError('source_host_private', HOST_PRIVATE_MESSAGE)
			: new PermanentError('source_unreachable', HOST_UNRESOLVED_MESSAGE);
	}
	// the fingerprint the server presented, kept so a refusal can say whether the key differed
	let presented: string | null = null;
	try {
		return await connector.connect({
			hostname: dial.address,
			port: target.port,
			username: target.user,
			privateKey: { pem: target.privateKey },
			timeoutMs: CONNECT_TIMEOUT_MS,
			hostKey: {
				async verify(_keyType, key) {
					presented = await connector.fingerprint(key);
					return presented === target.expectedFingerprint;
				}
			}
		});
	} catch (error) {
		if (presented !== null && presented !== target.expectedFingerprint) {
			throw new PermanentError('host_key_mismatch', HOST_KEY_MISMATCH_MESSAGE);
		}
		throw connectionRefusal(error);
	}
}

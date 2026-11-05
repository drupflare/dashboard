import { fromBase64Url, toBase64Url } from '@contracts/common';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const utf8 = (text: string) => new TextEncoder().encode(text);

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};

const sha256 = async (data: Uint8Array<ArrayBuffer>) =>
	new Uint8Array(await crypto.subtle.digest('SHA-256', data));

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

function derInteger(bytes: Uint8Array): Uint8Array {
	let start = 0;
	while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
	const body = bytes.slice(start);
	const padded = (body[0] as number) >= 0x80 ? concat(new Uint8Array([0]), body) : body;
	return concat(new Uint8Array([0x02, padded.length]), padded);
}

// webauthn wants an asn.1 signature; webcrypto returns r followed by s
function derSignature(raw: Uint8Array): Uint8Array {
	const body = concat(derInteger(raw.slice(0, 32)), derInteger(raw.slice(32)));
	return concat(new Uint8Array([0x30, body.length]), body);
}

const be32 = (value: number) => new Uint8Array([value >>> 24, value >>> 16, value >>> 8, value]);

export interface Overrides {
	origin?: string;
	rpId?: string;
	challenge?: string;
	type?: string;
	flags?: number;
	counter?: number;
	userHandle?: string | null;
	signWith?: CryptoKey;
}

export interface Authenticator {
	credentialId: string;
	counter: number;
	register(options: { challenge: string }, over?: Overrides): Promise<RegistrationResponseJSON>;
	assert(
		options: { challenge: string },
		userId: string,
		over?: Overrides
	): Promise<AuthenticationResponseJSON>;
}

export async function newKeyPair(): Promise<CryptoKeyPair> {
	return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
		'sign',
		'verify'
	]);
}

// a software authenticator: p-256 key, "none" attestation, user presence and verification set
export async function makeAuthenticator(config: {
	rpId: string;
	origin: string;
}): Promise<Authenticator> {
	const pair = await newKeyPair();
	const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
	const cose = new Map<number, number | Uint8Array>([
		[1, 2],
		[3, -7],
		[-1, 1],
		[-2, fromBase64Url(jwk.x as string)],
		[-3, fromBase64Url(jwk.y as string)]
	]);
	const credentialRaw = crypto.getRandomValues(new Uint8Array(32));
	const credentialId = toBase64Url(credentialRaw);
	const state = { counter: 0 };

	const client = (type: string, challenge: string, origin: string) =>
		utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

	return {
		credentialId,
		get counter() {
			return state.counter;
		},
		async register(options, over = {}) {
			const rpHash = await sha256(utf8(over.rpId ?? config.rpId));
			const authData = concat(
				rpHash,
				new Uint8Array([over.flags ?? FLAG_UP | FLAG_UV | FLAG_AT]),
				be32(over.counter ?? state.counter),
				new Uint8Array(16),
				new Uint8Array([credentialRaw.length >> 8, credentialRaw.length & 0xff]),
				credentialRaw,
				isoCBOR.encode(cose)
			);
			const attestation = isoCBOR.encode(
				new Map<string, string | Map<never, never> | Uint8Array>([
					['fmt', 'none'],
					['attStmt', new Map<never, never>()],
					['authData', authData]
				])
			);
			const clientData = client(
				over.type ?? 'webauthn.create',
				over.challenge ?? options.challenge,
				over.origin ?? config.origin
			);
			return {
				id: credentialId,
				rawId: credentialId,
				type: 'public-key',
				clientExtensionResults: {},
				response: {
					clientDataJSON: toBase64Url(clientData),
					attestationObject: toBase64Url(attestation),
					transports: ['internal']
				}
			};
		},
		async assert(options, userId, over = {}) {
			state.counter = over.counter ?? state.counter + 1;
			const rpHash = await sha256(utf8(over.rpId ?? config.rpId));
			const authData = concat(
				rpHash,
				new Uint8Array([over.flags ?? FLAG_UP | FLAG_UV]),
				be32(state.counter)
			);
			const clientData = client(
				over.type ?? 'webauthn.get',
				over.challenge ?? options.challenge,
				over.origin ?? config.origin
			);
			const signed = concat(authData, await sha256(clientData));
			const raw = new Uint8Array(
				await crypto.subtle.sign(
					{ name: 'ECDSA', hash: 'SHA-256' },
					over.signWith ?? pair.privateKey,
					signed
				)
			);
			const handle =
				over.userHandle === undefined ? toBase64Url(utf8(userId)) : over.userHandle;
			return {
				id: credentialId,
				rawId: credentialId,
				type: 'public-key',
				clientExtensionResults: {},
				response: {
					clientDataJSON: toBase64Url(clientData),
					authenticatorData: toBase64Url(authData),
					signature: toBase64Url(derSignature(raw)),
					...(handle === null ? {} : { userHandle: handle })
				}
			};
		}
	};
}

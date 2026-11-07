import { getCookie, getRequestHeader, type H3Event } from 'h3';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface AccessConfig {
	// the team name, as in https://<team>.cloudflareaccess.com
	team: string;
	// one audience tag per Access application that fronts a path
	audiences: readonly string[];
}

export interface AccessIdentity {
	email: string;
}

const keysByTeam = new Map<string, JWTVerifyGetKey>();

function remoteKeys(team: string): JWTVerifyGetKey {
	let keys = keysByTeam.get(team);
	if (!keys) {
		keys = createRemoteJWKSet(
			new URL(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`)
		);
		keysByTeam.set(team, keys);
	}
	return keys;
}

// the signed assertion Cloudflare Access adds after its own login; null for anything else
export async function verifyAccessToken(
	token: string | undefined,
	config: AccessConfig | null,
	keys?: JWTVerifyGetKey
): Promise<AccessIdentity | null> {
	if (!token || !config || config.team === '' || config.audiences.length === 0) return null;
	try {
		const { payload } = await jwtVerify(token, keys ?? remoteKeys(config.team), {
			issuer: `https://${config.team}.cloudflareaccess.com`,
			audience: [...config.audiences]
		});
		return typeof payload.email === 'string' && payload.email !== ''
			? { email: payload.email.toLowerCase() }
			: null;
	} catch {
		return null;
	}
}

export function accessTokenOf(event: H3Event): string | undefined {
	return (
		getRequestHeader(event, 'cf-access-jwt-assertion') ?? getCookie(event, 'CF_Authorization')
	);
}

export function accessConfigOf(
	team: string | undefined,
	audience: string | undefined
): AccessConfig | null {
	const audiences = (audience ?? '')
		.split(',')
		.map((value) => value.trim())
		.filter((value) => value !== '');
	return team && audiences.length > 0 ? { team, audiences } : null;
}

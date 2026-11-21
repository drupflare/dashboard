import type { CollegeDBClient } from '@earth-app/collegedb';
import type { Aad } from '../../shared/custody/envelope';
import { decryptRecordText, encryptRecord, type KeyRing } from '../../shared/custody/envelope';
import { ApiError } from '../../shared/errors';
import {
	SSO_SESSION_MAX_MS,
	ssoDomainRecord,
	type SsoConfigBody,
	type SsoRole,
	type SsoTestResult,
	type SsoView
} from '../../shared/sso';
import { DuplicateRowError } from '../db/collegedb';
import { getUserById, type User } from '../db/repos/identity';
import {
	getOrgSso,
	getOrgSsoBySlug,
	markOrgSsoVerified,
	saveOrgSso,
	type OrgSsoRow
} from '../db/repos/org-sso';
import { addMember, getMember, listMembers, setMemberRole } from '../db/repos/organization';
import { textOf, type DnsResolver } from '../domain/dns-check';
import { SsoError, emailDomainAllowed, groupsOf, mapRole, trimIssuer } from '../domain/sso';
import {
	beginOidc,
	checkProvider,
	completeOidc,
	type OidcClient,
	type OidcDeps
} from '../integrations/oidc';
import { createAccount, healAccount, type Directory } from './auth';
import { putPending, type IdentityStore } from './identities';
import { createSession, type IssuedSession, type KvStore } from './sessions';
import type { OnceStore } from './single-use';

// #region collaborators

export interface SsoStore {
	get(orgId: string): Promise<OrgSsoRow | null>;
	getBySlug(slug: string): Promise<OrgSsoRow | null>;
	save(row: OrgSsoRow): Promise<void>;
	markVerified(orgId: string, at: number): Promise<void>;
}

export interface SsoMembers {
	find(orgId: string, userId: string): Promise<{ id: string; role: string } | null>;
	add(orgId: string, userId: string, role: SsoRole): Promise<void>;
	setRole(orgId: string, memberId: string, role: SsoRole): Promise<void>;
	ownerEmails(orgId: string): Promise<string[]>;
}

export interface SsoServices {
	store: SsoStore;
	members: SsoMembers;
	identities: Pick<IdentityStore, 'findIdentity' | 'createIdentity'>;
	directory: Directory;
	kv: KvStore;
	once: OnceStore;
	ring: () => Promise<KeyRing>;
	oidc: OidcDeps;
	dns: DnsResolver;
	redirectUri: (slug: string) => string;
	// an essential security-event mail to one address; reviewPath is the page the mail's button opens
	notify: (to: string, summary: string, reviewPath: string) => Promise<void>;
	now: () => number;
}

let installed: SsoServices | null = null;

export function setSsoServices(services: SsoServices | null): void {
	installed = services;
}

export function ssoServices(): SsoServices {
	if (installed === null)
		throw new ApiError('not_built', 'Organisation sign-in is not available yet');
	return installed;
}

// #endregion

const secretAad = (orgId: string): Aad => ({ siteId: orgId, purpose: 'org-sso-client-secret' });

export const ssoProviderName = (orgId: string) => `sso:${orgId}`;

export function ssoView(row: OrgSsoRow | null, redirectUri: (slug: string) => string): SsoView {
	if (row === null) {
		return {
			configured: false,
			slug: null,
			issuer: null,
			clientId: null,
			secretSet: false,
			allowedDomains: [],
			roleMap: [],
			groupClaim: 'groups',
			defaultRole: 'viewer',
			enabled: false,
			lastVerifiedAt: null,
			redirectUri: null
		};
	}
	return {
		configured: true,
		slug: row.slug,
		issuer: row.issuer,
		clientId: row.clientId,
		secretSet: row.clientSecretEnvelope !== '',
		allowedDomains: row.allowedDomains,
		roleMap: row.roleMap,
		groupClaim: row.groupClaim,
		defaultRole: row.defaultRole,
		enabled: row.enabled,
		lastVerifiedAt:
			row.lastVerifiedAt === null ? null : new Date(row.lastVerifiedAt).toISOString(),
		redirectUri: redirectUri(row.slug)
	};
}

export async function getSso(deps: SsoServices, orgId: string): Promise<SsoView> {
	return ssoView(await deps.store.get(orgId), deps.redirectUri);
}

async function notifyOwners(deps: SsoServices, orgId: string, summary: string): Promise<void> {
	for (const address of await deps.members.ownerEmails(orgId)) {
		await deps.notify(address, summary, '/org/sso').catch(() => undefined);
	}
}

// #region configure

export async function configureSso(
	deps: SsoServices,
	input: { orgId: string; actorId: string; body: SsoConfigBody }
): Promise<SsoView> {
	const { orgId, actorId, body } = input;
	if (!body.issuer.startsWith('https://')) {
		throw new ApiError('validation', 'The issuer address must start with https://');
	}
	const existing = await deps.store.get(orgId);
	if (body.clientSecret === undefined && existing === null) {
		throw new ApiError('validation', 'Enter the client secret');
	}
	const secretChanged = body.clientSecret !== undefined;
	const identityChanged =
		existing === null ||
		secretChanged ||
		trimIssuer(existing.issuer) !== trimIssuer(body.issuer) ||
		existing.clientId !== body.clientId;
	// a new domain needs its own proof, so adding one sends the test through again
	const addedDomain =
		existing !== null &&
		body.allowedDomains.some((domain) => !existing.allowedDomains.includes(domain));
	const lastVerifiedAt =
		identityChanged || addedDomain ? null : (existing?.lastVerifiedAt ?? null);
	if (body.enabled && lastVerifiedAt === null) {
		throw new ApiError('conflict', 'Test the connection before you turn sign-in on', {
			reason: 'untested'
		});
	}
	const envelope =
		body.clientSecret === undefined
			? (existing?.clientSecretEnvelope ?? '')
			: JSON.stringify(
					await encryptRecord(body.clientSecret, secretAad(orgId), await deps.ring())
				);
	const now = deps.now();
	const row: OrgSsoRow = {
		organizationId: orgId,
		slug: body.slug,
		issuer: trimIssuer(body.issuer),
		clientId: body.clientId,
		clientSecretEnvelope: envelope,
		allowedDomains: [...new Set(body.allowedDomains)],
		roleMap: body.roleMap,
		groupClaim: body.groupClaim,
		defaultRole: body.defaultRole,
		enabled: body.enabled,
		lastVerifiedAt,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now
	};
	try {
		await deps.store.save(row);
	} catch (error) {
		if (error instanceof DuplicateRowError) {
			throw new ApiError('conflict', 'Another organisation already uses that sign-in name');
		}
		throw error;
	}
	await deps.directory.appendAudit(orgId, {
		actor: actorId,
		action: 'org.sso.configure',
		target: orgId,
		detail: { secretChanged }
	});
	const wasEnabled = existing?.enabled === true;
	if (row.enabled !== wasEnabled) {
		await deps.directory.appendAudit(orgId, {
			actor: actorId,
			action: row.enabled ? 'org.sso.enable' : 'org.sso.disable',
			target: orgId
		});
		await notifyOwners(
			deps,
			orgId,
			row.enabled
				? 'Sign-in through your organisation was turned on'
				: 'Sign-in through your organisation was turned off'
		);
	}
	return ssoView(row, deps.redirectUri);
}

// every allowed domain must carry the organisation's TXT record, or anyone who runs an identity
// provider could mint accounts for addresses at a domain they do not control
async function unprovenDomains(deps: SsoServices, orgId: string, domains: readonly string[]) {
	const missing: string[] = [];
	for (const domain of domains) {
		const record = ssoDomainRecord(orgId, domain);
		let proven = false;
		try {
			const reply = await deps.dns.query(record.name, 'TXT');
			proven =
				reply.ok &&
				reply.records.some(
					(r) => r.type === 'TXT' && textOf(r.data).trim() === record.value
				);
		} catch {
			proven = false;
		}
		if (!proven) missing.push(`${record.name} with the value ${record.value}`);
	}
	return missing;
}

export async function testSso(
	deps: SsoServices,
	input: { orgId: string; actorId: string }
): Promise<SsoTestResult> {
	const row = await deps.store.get(input.orgId);
	if (row === null) throw new ApiError('not_found', 'Organisation sign-in is not set up yet');
	deps.oidc.cache.discovery.delete(trimIssuer(row.issuer));
	let result: SsoTestResult;
	try {
		await checkProvider(deps.oidc, row.issuer);
		const missing = await unprovenDomains(deps, input.orgId, row.allowedDomains);
		if (missing.length > 0) {
			throw new SsoError(
				'domain',
				`Prove you own each domain first. Add a TXT record named ${missing.join(' and a TXT record named ')}.`
			);
		}
		await deps.store.markVerified(input.orgId, deps.now());
		result = {
			ok: true,
			message:
				'The identity provider answered, its keys were read and your domains are proven.'
		};
	} catch (error) {
		if (!(error instanceof SsoError)) throw error;
		result = { ok: false, message: error.message };
	}
	await deps.directory.appendAudit(input.orgId, {
		actor: input.actorId,
		action: 'org.sso.test',
		target: input.orgId,
		detail: { ok: result.ok }
	});
	return result;
}

// #endregion

// #region sign-in

async function clientOf(deps: SsoServices, row: OrgSsoRow): Promise<OidcClient> {
	const clientSecret = await decryptRecordText(
		JSON.parse(row.clientSecretEnvelope),
		secretAad(row.organizationId),
		await deps.ring()
	);
	return {
		issuer: row.issuer,
		clientId: row.clientId,
		clientSecret,
		redirectUri: deps.redirectUri(row.slug)
	};
}

async function enabledRow(deps: SsoServices, slug: string): Promise<OrgSsoRow> {
	const row = await deps.store.getBySlug(slug);
	if (row === null)
		throw new ApiError('not_found', 'No organisation sign-in was found there', {
			reason: 'unknown'
		});
	if (!row.enabled) {
		throw new ApiError('forbidden', 'Sign-in through this organisation is not turned on', {
			reason: 'disabled'
		});
	}
	return row;
}

export async function beginSsoSignIn(
	deps: SsoServices,
	slug: string
): Promise<{ url: string; state: string }> {
	const row = await enabledRow(deps, slug);
	try {
		return await beginOidc(deps.oidc, await clientOf(deps, row), {
			orgId: row.organizationId,
			slug: row.slug
		});
	} catch (error) {
		if (error instanceof SsoError) throw new ApiError('unprocessable', error.message);
		throw error;
	}
}

export type SsoSignIn =
	| ({ status: 'signed_in'; user: User; isNew: boolean } & IssuedSession)
	| { status: 'link_required'; email: string; token: string };

interface Context {
	userAgent?: string | null;
	ip?: string | null;
}

// a claim sets the role of anyone but an owner, so a removal at the provider lands at the next sign-in
async function syncMember(
	deps: SsoServices,
	row: OrgSsoRow,
	userId: string,
	role: SsoRole
): Promise<boolean> {
	const member = await deps.members.find(row.organizationId, userId);
	if (member === null) {
		await deps.members.add(row.organizationId, userId, role);
		await deps.directory.appendAudit(row.organizationId, {
			actor: userId,
			action: 'org.sso.provision',
			target: userId,
			detail: { role }
		});
		return true;
	}
	if (member.role !== 'owner' && member.role !== role) {
		await deps.members.setRole(row.organizationId, member.id, role);
		await deps.directory.appendAudit(row.organizationId, {
			actor: userId,
			action: 'org.sso.role-change',
			target: userId,
			detail: { from: member.role, to: role }
		});
	}
	return false;
}

export async function completeSsoSignIn(
	deps: SsoServices,
	slug: string,
	input: { code?: string; state?: string; error?: string; cookieState?: string },
	context: Context = {}
): Promise<SsoSignIn> {
	const row = await enabledRow(deps, slug);
	const { profile, claims } = await completeOidc(
		deps.oidc,
		await clientOf(deps, row),
		{ slug: row.slug },
		input
	);
	if (!emailDomainAllowed(profile.email, row.allowedDomains)) {
		throw new SsoError('domain', 'The email address is outside the allowed domains');
	}
	const role = mapRole(groupsOf(claims, row.groupClaim), row.roleMap, row.defaultRole);
	const provider = ssoProviderName(row.organizationId);
	const issue = async (user: User, isNew: boolean): Promise<SsoSignIn> => {
		await deps.directory.appendAudit(row.organizationId, {
			actor: user.id,
			action: 'org.sso.sign-in',
			target: user.id
		});
		const issued = await createSession(deps.kv, {
			userId: user.id,
			userAgent: context.userAgent,
			ip: context.ip,
			maxAgeMs: SSO_SESSION_MAX_MS
		});
		return { status: 'signed_in', user, isNew, ...issued };
	};
	const needsLink = async (): Promise<SsoSignIn> => {
		await deps.directory.appendAudit(row.organizationId, {
			actor: 'sso',
			action: 'org.sso.link-required',
			target: profile.subject
		});
		return {
			status: 'link_required',
			email: profile.email,
			token: await putPending(deps.once, {
				provider,
				subject: profile.subject,
				email: profile.email
			})
		};
	};

	const known = await deps.identities.findIdentity(provider, profile.subject);
	if (known) {
		const user = await deps.directory.findUserById(known.userId);
		if (!user) throw new SsoError('claims', 'The account for this sign-in no longer exists');
		await healAccount(deps.directory, user);
		await syncMember(deps, row, user.id, role);
		return issue(user, false);
	}
	// an address that already has an account is never joined on the strength of a provider claim
	if (await deps.directory.findUserByEmail(profile.email)) return needsLink();
	const created = await createAccount(deps.directory, profile.email, 'sso');
	if (created === null) return needsLink();
	try {
		await deps.identities.createIdentity({
			userId: created.id,
			provider,
			providerSubject: profile.subject,
			email: profile.email,
			verified: true
		});
	} catch (error) {
		if (error instanceof DuplicateRowError) return needsLink();
		throw error;
	}
	await syncMember(deps, row, created.id, role);
	return issue(created, true);
}

// #endregion

// #region wiring

export function collegeSsoStore(getDb: () => Promise<CollegeDBClient>): SsoStore {
	return {
		async get(orgId) {
			return getOrgSso(await getDb(), orgId);
		},
		async getBySlug(slug) {
			return getOrgSsoBySlug(await getDb(), slug);
		},
		async save(row) {
			await saveOrgSso(await getDb(), row);
		},
		async markVerified(orgId, at) {
			await markOrgSsoVerified(await getDb(), orgId, at);
		}
	};
}

const OWNER_PAGE = 100;

export function collegeSsoMembers(getDb: () => Promise<CollegeDBClient>): SsoMembers {
	return {
		async find(orgId, userId) {
			const member = await getMember(await getDb(), orgId, userId);
			return member ? { id: member.id, role: member.role } : null;
		},
		async add(orgId, userId, role) {
			try {
				await addMember(await getDb(), orgId, { userId, role });
			} catch (error) {
				if (!(error instanceof DuplicateRowError)) throw error;
			}
		},
		async setRole(orgId, memberId, role) {
			await setMemberRole(await getDb(), orgId, memberId, role);
		},
		async ownerEmails(orgId) {
			const db = await getDb();
			const page = await listMembers(db, orgId, { limit: OWNER_PAGE });
			const owners = page.items.filter((member) => member.role === 'owner');
			const users = await Promise.all(owners.map((owner) => getUserById(db, owner.userId)));
			return users.flatMap((user) => (user ? [user.email] : []));
		}
	};
}

// #endregion

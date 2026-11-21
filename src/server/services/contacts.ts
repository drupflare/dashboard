import { sha256Hex } from '@contracts/common';
import type { CollegeDBClient } from '@earth-app/collegedb';
import {
	CONTACT_ROLE_LABELS,
	CONTACT_VERIFY_TTL_MS,
	type ContactBody,
	type ContactRole,
	type ContactView,
	type TestResult
} from '../../shared/contacts';
import { ApiError } from '../../shared/errors';
import {
	getContact,
	listContacts,
	markContactVerified,
	upsertContact,
	type ContactRow
} from '../db/repos/contacts';
import { getOrganization } from '../db/repos/organization';
import { putSingleUse, takeSingleUse } from '../db/repos/single-use';
import type { MailInput } from '../emails';
import { randomToken } from './crypto';

// #region collaborators

export interface ContactMail {
	send(to: string, input: MailInput): Promise<void>;
}

export interface ContactServices {
	getDb: () => Promise<CollegeDBClient>;
	mail: ContactMail;
	baseUrl: string;
	now: () => number;
}

let installed: ContactServices | null = null;

export function setContactServices(services: ContactServices | null): void {
	installed = services;
}

export function contactServices(): ContactServices {
	if (installed === null) throw new ApiError('not_built', 'Contacts are not available yet');
	return installed;
}

// #endregion

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function viewOf(row: ContactRow): ContactView {
	return {
		role: row.role,
		name: row.name,
		email: row.email,
		verifiedAt: iso(row.verifiedAt),
		notifyOn: row.notifyOn,
		updatedAt: iso(row.updatedAt) ?? ''
	};
}

export async function listContactViews(
	deps: ContactServices,
	orgId: string
): Promise<ContactView[]> {
	return (await listContacts(await deps.getDb(), orgId)).map(viewOf);
}

// a changed address starts unverified; the same address keeps its verified state
export async function saveContact(
	deps: ContactServices,
	orgId: string,
	role: ContactRole,
	body: ContactBody
): Promise<ContactView> {
	const db = await deps.getDb();
	const existing = await getContact(db, orgId, role);
	const now = deps.now();
	const sameAddress = existing !== null && existing.email === body.email;
	const row: ContactRow = {
		id: existing?.id ?? `ct_${crypto.randomUUID()}`,
		organizationId: orgId,
		role,
		name: body.name,
		email: body.email,
		verifiedAt: sameAddress ? existing.verifiedAt : null,
		notifyOn: body.notifyOn,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now
	};
	await upsertContact(db, row);
	return viewOf(row);
}

// the token is random and only its hash is stored; the row it names is found by the org stored with it
async function tokenKey(token: string): Promise<string> {
	return `contact-verify:${await sha256Hex(token)}`;
}

export async function requestVerification(
	deps: ContactServices,
	orgId: string,
	role: ContactRole
): Promise<ContactView> {
	const db = await deps.getDb();
	const contact = await getContact(db, orgId, role);
	if (contact === null) throw new ApiError('not_found', 'Not found');
	const org = await getOrganization(db, orgId);
	const token = randomToken(32);
	const now = deps.now();
	await putSingleUse(
		db,
		await tokenKey(token),
		JSON.stringify({ orgId, role, email: contact.email }),
		now + CONTACT_VERIFY_TTL_MS,
		now
	);
	try {
		await deps.mail.send(contact.email, {
			kind: 'contact-verify',
			orgName: org?.name ?? 'your organisation',
			role: CONTACT_ROLE_LABELS[role],
			confirmUrl: `${deps.baseUrl}/contacts/confirm?token=${encodeURIComponent(token)}`,
			expiresInDays: CONTACT_VERIFY_TTL_MS / (24 * 60 * 60 * 1000)
		});
	} catch {
		throw new ApiError(
			'unprocessable',
			'The mail service did not accept the message. Try again later.'
		);
	}
	return viewOf(contact);
}

// a token is spent on the first try, so a replay and a wrong address both get the same answer
export async function confirmContact(deps: ContactServices, token: string): Promise<void> {
	const db = await deps.getDb();
	const stored = await takeSingleUse(db, await tokenKey(token), deps.now());
	const invalid = () =>
		new ApiError('validation', 'This link is no longer valid. Ask for a new one.');
	if (stored === null) throw invalid();
	const claim = JSON.parse(stored) as { orgId: string; role: ContactRole; email: string };
	const contact = await getContact(db, claim.orgId, claim.role);
	if (contact === null || contact.email !== claim.email) throw invalid();
	await markContactVerified(db, {
		organizationId: claim.orgId,
		role: claim.role,
		email: claim.email,
		at: deps.now()
	});
}

export async function sendTest(
	deps: ContactServices,
	orgId: string,
	role: ContactRole
): Promise<TestResult> {
	const db = await deps.getDb();
	const contact = await getContact(db, orgId, role);
	if (contact === null) throw new ApiError('not_found', 'Not found');
	if (contact.verifiedAt === null) {
		throw new ApiError('precondition_failed', 'Verify this contact before you send a test');
	}
	if (!contact.notifyOn) {
		return {
			sent: false,
			message: 'This contact is off for notifications. Turn notifications on to send a test.'
		};
	}
	const org = await getOrganization(db, orgId);
	try {
		await deps.mail.send(contact.email, {
			kind: 'test-notice',
			orgName: org?.name ?? 'your organisation',
			role: CONTACT_ROLE_LABELS[role],
			sentAt: new Date(deps.now()).toISOString(),
			settingsUrl: `${deps.baseUrl}/org/contacts`
		});
	} catch {
		return {
			sent: false,
			message: 'The mail service did not accept the test. Try again later.'
		};
	}
	return { sent: true, message: 'The test was sent to the verified contact.' };
}

import { toBase64Url, utf8 } from '@contracts/common';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { CONTACT_ROLES, type ContactRole } from '../../shared/contacts';
import { ApiError } from '../../shared/errors';
import {
	ESSENTIAL_NOTICES,
	SWITCHES,
	type PreferencesView,
	type UnsubscribeResult
} from '../../shared/notification-preferences';
import {
	NOTIFICATION_CATEGORIES,
	OPTIONAL_CATEGORIES,
	type NotificationCategory,
	type OptionalCategory
} from '../../shared/notifications';
import { personalOrganizationId } from '../db/repos/accounts';
import { setContactNotify } from '../db/repos/contacts';
import { listPreferences, setPreference } from '../db/repos/notification-preferences';
import type { AuditInput } from './audit';
import {
	UnsubscribeError,
	isEssential,
	unsubscribeToken,
	verifyUnsubscribe,
	type NotificationPrefs
} from './notifications';

// #region collaborators

export interface PreferenceServices {
	getDb: () => Promise<CollegeDBClient>;
	audit: (orgId: string, input: AuditInput) => Promise<void>;
	now: () => number;
	// the secret the unsubscribe key comes from; absent means no unsubscribe link can be made
	keySecret: string | undefined;
	baseUrl: string;
}

let installed: PreferenceServices | null = null;

export function setPreferenceServices(services: PreferenceServices | null): void {
	installed = services;
	derived = null;
}

export function preferenceServices(): PreferenceServices {
	if (installed === null) throw new ApiError('not_built', 'Preferences are not available yet');
	return installed;
}

// #endregion

// #region unsubscribe key

export const UNSUBSCRIBE_CONTEXT = 'drupflare.unsubscribe.v1';

// HKDF gives the unsubscribe signer its own key, so the source secret never signs a link itself
export async function deriveUnsubscribeKey(secret: string): Promise<string> {
	const base = await crypto.subtle.importKey('raw', utf8(secret), 'HKDF', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: utf8('drupflare.v1'),
			info: utf8(UNSUBSCRIBE_CONTEXT)
		},
		base,
		256
	);
	return toBase64Url(new Uint8Array(bits));
}

let derived: { secret: string; key: string } | null = null;

export async function unsubscribeKeyOf(deps: PreferenceServices): Promise<string | null> {
	if (deps.keySecret === undefined || deps.keySecret === '') return null;
	if (derived?.secret !== deps.keySecret) {
		derived = { secret: deps.keySecret, key: await deriveUnsubscribeKey(deps.keySecret) };
	}
	return derived.key;
}

// #endregion

// #region subjects

// a token names a user or an organisation contact, never both
export type Subject =
	{ kind: 'user'; userId: string } | { kind: 'contact'; orgId: string; role: ContactRole };

export const userSubject = (userId: string) => `u:${userId}`;
export const contactSubject = (orgId: string, role: ContactRole) => `k:${orgId}:${role}`;

function parseSubject(value: string): Subject | null {
	if (value.startsWith('u:') && value.length > 2) return { kind: 'user', userId: value.slice(2) };
	if (!value.startsWith('k:')) return null;
	const rest = value.slice(2);
	const cut = rest.lastIndexOf(':');
	const role = rest.slice(cut + 1);
	const orgId = rest.slice(0, cut);
	if (cut < 1 || !(CONTACT_ROLES as readonly string[]).includes(role)) return null;
	return { kind: 'contact', orgId, role: role as ContactRole };
}

export interface MailRecipient {
	userId: string | null;
	contact?: { orgId: string; role: ContactRole };
}

// the link goes to the api route so the one-click POST in the list headers reaches it; a browser
// following it lands on the page
export async function unsubscribeUrlFor(
	deps: PreferenceServices,
	recipient: MailRecipient,
	category: NotificationCategory
): Promise<string> {
	const key = await unsubscribeKeyOf(deps);
	if (key === null) throw new ApiError('not_built', 'Unsubscribe links are not available yet');
	const subject =
		recipient.userId !== null
			? userSubject(recipient.userId)
			: recipient.contact
				? contactSubject(recipient.contact.orgId, recipient.contact.role)
				: null;
	if (subject === null) throw new ApiError('internal', 'The recipient has no unsubscribe target');
	const token = await unsubscribeToken(subject, category, key, deps.now());
	return `${deps.baseUrl}/api/v1/unsubscribe?token=${encodeURIComponent(token)}`;
}

// #endregion

// #region preferences

// what the senders read; a category with no stored row is off
export async function prefsOf(db: CollegeDBClient, userId: string): Promise<NotificationPrefs> {
	return listPreferences(db, userId);
}

function viewOf(stored: Partial<Record<OptionalCategory, boolean>>): PreferencesView {
	return {
		switches: SWITCHES.map((info) => ({
			...info,
			enabled: info.available && stored[info.category] === true
		})),
		essential: [...ESSENTIAL_NOTICES]
	};
}

export async function getPreferencesView(
	deps: PreferenceServices,
	userId: string
): Promise<PreferencesView> {
	return viewOf(await listPreferences(await deps.getDb(), userId));
}

function checked(changes: Record<string, boolean>): [OptionalCategory, boolean][] {
	const out: [OptionalCategory, boolean][] = [];
	for (const [name, enabled] of Object.entries(changes)) {
		if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(name)) {
			throw new ApiError('validation', `${name} is not a mail category`);
		}
		if (isEssential(name as NotificationCategory)) {
			throw new ApiError(
				'validation',
				'This mail always sends and cannot be switched off. It has no switch.'
			);
		}
		if (name === 'digest') {
			throw new ApiError('validation', 'The daily summary is not available yet.');
		}
		out.push([name as OptionalCategory, enabled]);
	}
	return out;
}

// writes only what differs from the stored value, one audit row each
async function applyChange(
	deps: PreferenceServices,
	db: CollegeDBClient,
	userId: string,
	category: OptionalCategory,
	enabled: boolean,
	via: 'settings' | 'unsubscribe'
): Promise<boolean> {
	const current = (await listPreferences(db, userId))[category] === true;
	if (current === enabled) return false;
	const at = deps.now();
	await setPreference(db, { userId, category, enabled, at });
	await deps.audit(personalOrganizationId(userId), {
		actor: userId,
		action: 'account.notifications.update',
		target: category,
		detail: { enabled, via }
	});
	return true;
}

// the user id comes from the session, never from the body
export async function setPreferences(
	deps: PreferenceServices,
	userId: string,
	changes: Record<string, boolean>
): Promise<PreferencesView> {
	const entries = checked(changes);
	const db = await deps.getDb();
	for (const [category, enabled] of entries) {
		await applyChange(deps, db, userId, category, enabled, 'settings');
	}
	return viewOf(await listPreferences(db, userId));
}

// #endregion

// #region unsubscribe

const invalidLink = () =>
	new ApiError(
		'validation',
		'This link is no longer valid. Sign in to change your email settings.'
	);

// switches off only the category in the token; a replay finds it already off and changes nothing
export async function unsubscribe(
	deps: PreferenceServices,
	token: string
): Promise<UnsubscribeResult> {
	const key = await unsubscribeKeyOf(deps);
	if (key === null) throw new ApiError('not_built', 'Unsubscribe links are not available yet');
	let verified: Awaited<ReturnType<typeof verifyUnsubscribe>>;
	try {
		verified = await verifyUnsubscribe(token, key, deps.now());
	} catch (error) {
		if (error instanceof UnsubscribeError) throw invalidLink();
		throw error;
	}
	const subject = parseSubject(verified.userId);
	if (
		subject === null ||
		!(OPTIONAL_CATEGORIES as readonly string[]).includes(verified.category)
	) {
		throw invalidLink();
	}
	const db = await deps.getDb();
	if (subject.kind === 'user') {
		await applyChange(deps, db, subject.userId, verified.category, false, 'unsubscribe');
	} else {
		await setContactNotify(db, {
			organizationId: subject.orgId,
			role: subject.role,
			notifyOn: false,
			at: deps.now()
		});
	}
	return { unsubscribed: true, category: verified.category };
}

// #endregion

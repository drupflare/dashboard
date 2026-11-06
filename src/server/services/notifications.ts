import { z } from 'zod';
import { fromBase64Url, toBase64Url, utf8 } from '../../../contracts/src/common';
import {
	ESSENTIAL_CATEGORIES,
	OPTIONAL_CATEGORIES,
	type EssentialCategory,
	type NotificationCategory,
	type OptionalCategory
} from '../../shared/notifications';
import { hmacSha256Base64Url, timingSafeEqual } from './crypto';

// #region classes

const ESSENTIAL: ReadonlySet<string> = new Set(ESSENTIAL_CATEGORIES);
const OPTIONAL: ReadonlySet<string> = new Set(OPTIONAL_CATEGORIES);

export function isEssential(category: NotificationCategory): category is EssentialCategory {
	return ESSENTIAL.has(category);
}

export type NotificationPrefs = Partial<Record<NotificationCategory, boolean>>;

export function shouldSend(category: NotificationCategory, prefs: NotificationPrefs): boolean {
	if (isEssential(category)) return true;
	return prefs[category] === true;
}

// #endregion

// #region budget

export interface Queued {
	category: NotificationCategory;
}

// essential mail is never deferred; optional mail fills what the budget leaves after it
export function budgetOrder<T extends Queued>(
	batch: readonly T[],
	remaining: number
): { send: T[]; deferred: T[] } {
	const essential = batch.filter((item) => isEssential(item.category));
	const optional = OPTIONAL_CATEGORIES.flatMap((category) =>
		batch.filter((item) => item.category === category)
	);
	const room = Math.max(0, remaining - essential.length);
	return { send: [...essential, ...optional.slice(0, room)], deferred: optional.slice(room) };
}

// #endregion

// #region digest

export interface DigestItem extends Queued {
	id: string;
	at: number;
	summary: string;
}

export interface DigestWindow {
	start: number;
	end: number;
}

export interface Digest {
	window: DigestWindow;
	groups: { category: OptionalCategory; items: DigestItem[] }[];
}

// returns null when no optional item falls inside the window
export function digest(items: readonly DigestItem[], window: DigestWindow): Digest | null {
	const inWindow = items.filter(
		(item) => !isEssential(item.category) && item.at >= window.start && item.at < window.end
	);
	const groups = OPTIONAL_CATEGORIES.map((category) => ({
		category,
		items: inWindow
			.filter((item) => item.category === category)
			.sort((left, right) => left.at - right.at)
	})).filter((group) => group.items.length > 0);
	return groups.length > 0 ? { window, groups } : null;
}

// #endregion

// #region unsubscribe

export type UnsubscribeErrorCode = 'malformed' | 'bad_signature' | 'wrong_category' | 'expired';

export class UnsubscribeError extends Error {
	readonly code: UnsubscribeErrorCode;

	constructor(code: UnsubscribeErrorCode, message: string) {
		super(message);
		this.name = 'UnsubscribeError';
		this.code = code;
	}
}

const UNSUBSCRIBE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const payloadSchema = z.object({
	v: z.literal(1),
	u: z.string().min(1),
	c: z.string(),
	e: z.number().int()
});

// the prefix keeps a signature made for another purpose under the same key from verifying here
const signingInput = (encoded: string) => `drupflare.unsubscribe.v1.${encoded}`;

export async function unsubscribeToken(
	userId: string,
	category: NotificationCategory,
	key: string,
	now = Date.now()
): Promise<string> {
	if (!OPTIONAL.has(category)) {
		throw new UnsubscribeError('wrong_category', `${category} mail has no unsubscribe link`);
	}
	const encoded = toBase64Url(
		utf8(JSON.stringify({ v: 1, u: userId, c: category, e: now + UNSUBSCRIBE_TTL_MS }))
	);
	return `${encoded}.${await hmacSha256Base64Url(key, signingInput(encoded))}`;
}

// the signature is checked before the payload is read, so any edit reports as a bad signature
export async function verifyUnsubscribe(
	token: string,
	key: string,
	now = Date.now()
): Promise<{ userId: string; category: OptionalCategory }> {
	const parts = token.split('.');
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		throw new UnsubscribeError('malformed', 'the unsubscribe token has no signature');
	}
	const [encoded, signature] = parts as [string, string];
	const expected = await hmacSha256Base64Url(key, signingInput(encoded));
	if (!timingSafeEqual(expected, signature)) {
		throw new UnsubscribeError('bad_signature', 'the unsubscribe token signature is wrong');
	}

	let decoded: unknown;
	try {
		decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded)));
	} catch {
		throw new UnsubscribeError('malformed', 'the unsubscribe token payload is not JSON');
	}
	const payload = payloadSchema.safeParse(decoded);
	if (!payload.success) {
		throw new UnsubscribeError(
			'malformed',
			'the unsubscribe token payload has the wrong shape'
		);
	}
	if (!OPTIONAL.has(payload.data.c)) {
		throw new UnsubscribeError(
			'wrong_category',
			'the token names a category with no unsubscribe'
		);
	}
	if (now >= payload.data.e)
		throw new UnsubscribeError('expired', 'the unsubscribe token expired');
	return { userId: payload.data.u, category: payload.data.c as OptionalCategory };
}

// #endregion

// #region headers

// one-click list headers, for optional mail only
export function listHeaders(
	category: NotificationCategory,
	unsubscribeUrl: string
): Record<string, string> {
	if (isEssential(category)) return {};
	return {
		'List-Unsubscribe': `<${unsubscribeUrl}>`,
		'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
	};
}

// #endregion

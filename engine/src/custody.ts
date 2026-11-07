import type { PendingSecretKind } from '../../src/shared/custody/records';
import { PermanentError } from './step';

// #region the port

// names the response fields to seal; absent means the call returns nothing to keep
export interface FirstRunReads {
	ownerToken?: string;
	adminPassword?: string;
	// the account the call made; neither is a secret, so both are kept as plain text
	adminName?: string;
	adminMail?: string;
}

export interface FirstRunSecrets {
	ownerToken: string | null;
	adminPassword: string | null;
}

export interface FirstRunAdmin {
	adminName: string | null;
	adminMail: string | null;
}

export interface SealedIds {
	ownerTokenId: string | null;
	pendingSecretId: string | null;
}

// every method takes or returns an id, never a value; the one place a token is readable is the
// callback of withOwnerToken
export interface Custody {
	sealed(siteId: string): Promise<SealedIds>;
	sealOwnerToken(siteId: string, token: string): Promise<string>;
	sealPendingSecret(siteId: string, kind: PendingSecretKind, value: string): Promise<string>;
	withOwnerToken<T>(
		siteId: string,
		ownerTokenId: string,
		use: (token: string) => Promise<T>
	): Promise<T>;
	// the pending secret only; the owner token stays for a site that may still be restored
	discardPending(siteId: string): Promise<void>;
	discard(siteId: string): Promise<void>;
}

// #endregion

// #region errors

export type CustodyErrorCode = 'unknown_id' | 'not_sealed' | 'bad_record' | 'conflict';

// the messages are fixed text, so nothing a step throws can carry a value
export class CustodyError extends PermanentError {
	constructor(code: CustodyErrorCode, message: string) {
		super(`custody_${code}`, message);
	}
}

// a retryable failure: the step runs again and finds the sealed row or fails for good
export class CustodySealError extends Error {
	constructor(what: string) {
		super(`${what} could not be sealed`);
		this.name = 'CustodySealError';
	}
}

// #endregion

// #region the first-run call

const MAX_SECRET_CHARS = 4096;

// a password in the call would sit in the workflow's saved input; the worker makes its own, and
// takes the request and the response under one field name
export function refuseSuppliedPassword(body: string | undefined, reads: FirstRunReads): void {
	if (body === undefined || reads.adminPassword === undefined) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return;
	}
	if (typeof parsed === 'object' && parsed !== null && reads.adminPassword in parsed) {
		throw new PermanentError(
			'first_run_password_supplied',
			'the first-run call must not carry an admin password'
		);
	}
}

function field(parsed: Record<string, unknown>, name: string | undefined): string | null {
	if (name === undefined) return null;
	const value = parsed[name];
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string' || value === '' || value.length > MAX_SECRET_CHARS) {
		throw new PermanentError(
			'first_run_response_unreadable',
			'the first-run response was not readable'
		);
	}
	return value;
}

function responseRecord(text: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new PermanentError(
			'first_run_response_unreadable',
			'the first-run response was not readable'
		);
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new PermanentError(
			'first_run_response_unreadable',
			'the first-run response was not readable'
		);
	}
	return parsed as Record<string, unknown>;
}

// the parser's own error text can quote the body, so it is dropped
export function readFirstRunSecrets(text: string, reads: FirstRunReads): FirstRunSecrets {
	const record = responseRecord(text);
	return {
		ownerToken: field(record, reads.ownerToken),
		adminPassword: field(record, reads.adminPassword)
	};
}

const MAX_ADMIN_NAME_CHARS = 255;
const MAX_ADMIN_MAIL_CHARS = 320;

function plain(record: Record<string, unknown>, name: string | undefined, max: number) {
	if (name === undefined) return null;
	const value = record[name];
	return typeof value === 'string' && value !== '' && value.length <= max ? value : null;
}

// a missing or odd value is null: the create has worked by then, and the sign-in line is a courtesy
export function readFirstRunAdmin(text: string, reads: FirstRunReads): FirstRunAdmin {
	const record = responseRecord(text);
	return {
		adminName: plain(record, reads.adminName, MAX_ADMIN_NAME_CHARS),
		adminMail: plain(record, reads.adminMail, MAX_ADMIN_MAIL_CHARS)
	};
}

// #endregion

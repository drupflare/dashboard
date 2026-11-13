import { newId } from '@contracts/common';
import { computePlanDigest, DEFAULT_CHANGE_BUDGET } from '@contracts/operations';
import { categoryOfKind } from '@contracts/sites';
import { z } from 'zod';
import { readSurveyCursor } from '../../../engine/src/import-parts';
import {
	planImportSurvey,
	type ImportSurveyInput
} from '../../../engine/src/workflows/import-survey';
import { planSiteImport, type SiteImportInput } from '../../../engine/src/workflows/site-import';
import { encryptRecord, type KeyRing } from '../../shared/custody/envelope';
import {
	credentialRefusal,
	IMPORT_CREDENTIAL_TTL_MS,
	importCredentialAad,
	newImportCredentialId
} from '../../shared/custody/import-credentials';
import { ApiError } from '../../shared/errors';
import { recipeFor } from '../../shared/recipes';
import { nowUtc } from '../../shared/utils/time';
import { createOperationRecord } from '../db/repos/backups';
import { getUserById } from '../db/repos/identity';
import {
	confirmImportHostKey,
	getImportCredential,
	insertImportCredential,
	type ImportCredentialRow
} from '../db/repos/import-credentials';
import {
	createSiteOperation,
	getOperation,
	getOperationByKey,
	type StoredOperation
} from '../db/repos/operations';
import { setSiteState } from '../db/repos/sites';
import { publicAddressOf } from '../integrations/ssh-host';
import { generateKeypair, type HostKey } from '../integrations/ssh-key';
import type { Resolver } from '../integrations/url-guard';
import type { AuditInput } from './audit';
import { backupServices } from './backups';
import { buildSiteCreateInput, SiteInputError } from './site-input';
import { entitlementRefusal, startRecorded, type SiteServices } from './sites';

export interface ImportServices {
	audit: (orgId: string, input: AuditInput) => Promise<unknown>;
	ring: () => Promise<KeyRing>;
	resolve: Resolver;
	// connects, reads the host key the server presents and stops before any login
	probe: (target: { host: string; port: number }) => Promise<HostKey>;
	// false while a new site has no route that takes a files archive
	filesLandable: boolean;
	now: () => number;
}

const notBuilt = (what: string) => async (): Promise<never> => {
	throw new ApiError('not_built', `${what} is not available yet`);
};

function productionServices(): ImportServices {
	return {
		audit: notBuilt('The audit log'),
		ring: notBuilt('Secret custody'),
		resolve: notBuilt('The address lookup'),
		probe: notBuilt('The host key check'),
		filesLandable: false,
		now: Date.now
	};
}

let installed = productionServices();

export function setImportServices(over: Partial<ImportServices>): void {
	installed = { ...installed, ...over };
}

export function resetImportServices(): void {
	installed = productionServices();
}

export function importServices(): ImportServices {
	return installed;
}

// #region the server address

const HOSTNAME =
	/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f:.]{2,45}$/i;

export const importHostSchema = z
	.string()
	.min(1)
	.max(253)
	.refine(
		(value) =>
			HOSTNAME.test(value) || IPV4.test(value) || (IPV6.test(value) && value.includes(':')),
		{
			message: 'The host must be a server name or an IP address'
		}
	);

export const importRootSchema = z
	.string()
	.min(1)
	.max(200)
	.regex(/^\/[A-Za-z0-9._/-]*$/, 'The path must be absolute and use plain characters')
	.refine((value) => !value.split('/').includes('..'), 'The path cannot climb out of a folder');

// the address to dial for the server, checked again at every connection and not only at creation,
// since a name can answer differently later; the caller dials this address and never the name
export async function checkImportHost(host: string, resolve: Resolver): Promise<string> {
	const found = await publicAddressOf(host, resolve);
	if (found.ok) return found.address;
	throw found.reason === 'host_private'
		? refusal('host_private', 'That server is not on the public internet')
		: refusal('host_unresolved', 'That server name could not be found');
}

const refusal = (reason: string, message: string) =>
	new ApiError('unprocessable', message, { reason });

// #endregion

// #region the credential

export interface CredentialView {
	id: string;
	// the line to add to authorized_keys, shown once; the private half is never returned
	publicKey: string;
	host: string;
	port: number;
	username: string;
	expiresAt: string;
}

export interface HostKeyView {
	credentialId: string;
	hostKeyType: string;
	fingerprint: string;
	confirmed: boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();

export interface CreateCredentialInput {
	orgId: string;
	userId: string;
	actor: string;
	host: string;
	port: number;
	username: string;
}

// the private key exists in this function and in the row, sealed to the credential id; the reply
// and the audit row carry the public half and the address only
export async function createImportCredential(
	services: SiteServices,
	custody: ImportServices,
	input: CreateCredentialInput
): Promise<CredentialView> {
	await checkImportHost(input.host, custody.resolve);
	const ring = await custody.ring();
	const db = await services.getDb();
	const id = newImportCredentialId();
	const { privateKeyPem, publicKey } = await generateKeypair();
	const envelope = await encryptRecord(privateKeyPem, importCredentialAad(id), ring);
	const now = custody.now();
	const expiresAt = now + IMPORT_CREDENTIAL_TTL_MS;
	await insertImportCredential(db, {
		id,
		organizationId: input.orgId,
		userId: input.userId,
		keyEnvelope: JSON.stringify(envelope),
		publicKey,
		host: input.host.toLowerCase(),
		port: input.port,
		username: input.username,
		createdAt: now,
		expiresAt
	});
	await custody.audit(input.orgId, {
		actor: input.actor,
		action: 'site.import.credential',
		target: id,
		detail: { host: input.host.toLowerCase(), port: input.port, username: input.username }
	});
	return {
		id,
		publicKey,
		host: input.host.toLowerCase(),
		port: input.port,
		username: input.username,
		expiresAt: iso(expiresAt)
	};
}

async function openCredential(
	services: SiteServices,
	custody: ImportServices,
	orgId: string,
	credentialId: string
): Promise<ImportCredentialRow> {
	const row = await getImportCredential(await services.getDb(), orgId, credentialId);
	if (row === null) throw new ApiError('not_found', 'Not found');
	if (row.expiresAt <= custody.now()) {
		throw refusal('credential_expired', 'The key for this import expired. Start again.');
	}
	return row;
}

// without a confirmation this reads the key the server shows; with one it reads the key again and
// stores it only if it is the key the owner was shown, so a swap in between is refused
export async function checkHostKey(
	services: SiteServices,
	custody: ImportServices,
	input: {
		orgId: string;
		actor: string;
		credentialId: string;
		confirm?: { fingerprint: string };
	}
): Promise<HostKeyView> {
	const row = await openCredential(services, custody, input.orgId, input.credentialId);
	// the name is resolved and checked again now, and the probe dials the address that passed
	const address = await checkImportHost(row.host, custody.resolve);
	const seen = await custody.probe({ host: address, port: row.port });
	if (input.confirm === undefined) {
		return {
			credentialId: row.id,
			hostKeyType: seen.type,
			fingerprint: seen.fingerprint,
			confirmed: row.hostKeyFingerprint === seen.fingerprint
		};
	}
	if (seen.fingerprint !== input.confirm.fingerprint) {
		throw new ApiError(
			'conflict',
			'The server now shows a different host key than the one you were shown.',
			{ reason: 'host_key_changed' }
		);
	}
	if (row.hostKeyFingerprint !== null && row.hostKeyFingerprint !== seen.fingerprint) {
		throw new ApiError('conflict', 'A different host key was confirmed for this key already.', {
			reason: 'host_key_confirmed'
		});
	}
	const db = await services.getDb();
	await confirmImportHostKey(db, input.orgId, row.id, {
		fingerprint: seen.fingerprint,
		type: seen.type
	});
	await custody.audit(input.orgId, {
		actor: input.actor,
		action: 'site.import.credential',
		target: row.id,
		detail: { hostKeyConfirmed: seen.fingerprint, hostKeyType: seen.type }
	});
	return {
		credentialId: row.id,
		hostKeyType: seen.type,
		fingerprint: seen.fingerprint,
		confirmed: true
	};
}

function usable(row: ImportCredentialRow, now: number): void {
	const problem = credentialRefusal(row, now);
	if (problem === 'expired') {
		throw refusal('credential_expired', 'The key for this import expired. Start again.');
	}
	if (problem === 'host_key_unconfirmed') {
		throw refusal('host_key_unconfirmed', 'Confirm the host key of the server first.');
	}
}

// #endregion

// #region the survey

export interface StartSurveyInput {
	orgId: string;
	actor: string;
	credentialId: string;
	root: string;
	idempotencyKey: string;
}

// the engine reads the server and leaves the dossier in the operation's cursor
export async function startImportSurvey(
	services: SiteServices,
	custody: ImportServices,
	input: StartSurveyInput
): Promise<StoredOperation> {
	const db = await services.getDb();
	const known = await getOperationByKey(db, input.orgId, input.idempotencyKey);
	if (known) {
		if (
			known.operation.type !== 'import.survey' ||
			known.operation.targetIds[0] !== input.credentialId
		) {
			throw new ApiError('conflict', 'This Idempotency-Key belongs to a different request', {
				reason: 'idempotency_key_reused'
			});
		}
		return known;
	}
	const row = await openCredential(services, custody, input.orgId, input.credentialId);
	usable(row, custody.now());
	const operationId = newId('op');
	const params: ImportSurveyInput = {
		operationId,
		orgId: input.orgId,
		credentialId: input.credentialId,
		root: input.root,
		ceilingBytes: backupServices().restoreCeilingBytes,
		filesLandable: custody.filesLandable
	};
	const plan = planImportSurvey(params);
	const { operation, created } = await createOperationRecord(db, {
		id: operationId,
		organizationId: input.orgId,
		accountId: null,
		siteId: null,
		type: 'import.survey',
		status: 'planned',
		idempotencyKey: input.idempotencyKey,
		targetIds: plan.targetIds,
		preconditions: plan.preconditions,
		planDigest: await computePlanDigest(plan),
		blastRadius: plan.blastRadius,
		rollbackPoint: plan.rollbackPoint,
		verification: 'not-required',
		budget: DEFAULT_CHANGE_BUDGET,
		steps: plan.steps,
		inputs: params,
		now: nowUtc().toMillis()
	});
	if (!created) return operation;
	await custody.audit(input.orgId, {
		actor: input.actor,
		action: 'site.import.survey',
		target: input.credentialId,
		detail: { operationId, host: row.host, root: input.root }
	});
	return startRecorded(
		services,
		db,
		input.orgId,
		operation,
		{
			workflow: 'import-survey',
			id: operationId,
			params: params as unknown as Record<string, unknown>
		},
		'The check could not be started'
	);
}

// #endregion

// #region the import

export interface StartImportInput {
	orgId: string;
	userId: string;
	actor: string;
	credentialId: string;
	// the survey operation whose dossier the owner confirmed
	surveyId: string;
	name: string;
	hostnameLabel: string | undefined;
	idempotencyKey: string;
}

export async function startSiteImport(
	services: SiteServices,
	custody: ImportServices,
	input: StartImportInput
): Promise<StoredOperation> {
	const db = await services.getDb();
	const known = await getOperationByKey(db, input.orgId, input.idempotencyKey);
	if (known) {
		if (
			known.operation.type !== 'site.import' ||
			known.operation.targetIds[1] !== input.credentialId
		) {
			throw new ApiError('conflict', 'This Idempotency-Key belongs to a different request', {
				reason: 'idempotency_key_reused'
			});
		}
		return known;
	}
	const survey = await getOperation(db, input.orgId, input.surveyId);
	if (
		survey === null ||
		survey.operation.type !== 'import.survey' ||
		survey.operation.targetIds[0] !== input.credentialId
	) {
		throw new ApiError('not_found', 'Not found');
	}
	const record = readSurveyCursor(survey.operation.cursor);
	if (survey.operation.status !== 'succeeded' || record === null) {
		throw refusal('survey_not_done', 'The check of the server has not finished.');
	}
	const { dossier } = record;
	if (!dossier.importable) {
		throw refusal(
			'dossier_refused',
			'The check found a reason this site cannot be imported yet.'
		);
	}
	const row = await openCredential(services, custody, input.orgId, input.credentialId);
	usable(row, custody.now());

	const kind = 'drupal';
	const decision = await services.entitlements.check({
		orgId: input.orgId,
		userId: input.userId,
		kind
	});
	if (!decision.allow) throw entitlementRefusal(decision.reason);

	const targetId = newId('site');
	const operationId = newId('op');
	const { config } = services;
	const owner = await getUserById(db, input.userId);
	let engineInput;
	try {
		engineInput = await buildSiteCreateInput({
			site: {
				id: targetId,
				name: input.name,
				kind,
				category: categoryOfKind(kind),
				plane: 'managed',
				label: input.hostnameLabel ?? input.name
			},
			organization: { id: input.orgId, planId: decision.entitlement.planId },
			operation: { id: operationId },
			recipe: recipeFor(kind),
			release: config.releases[kind],
			account: config.accountId,
			hostSuffix: config.hostSuffix,
			labelSuffix: config.labelSuffix,
			...(owner === null ? {} : { ownerEmail: owner.email })
		});
	} catch (error) {
		if (!(error instanceof SiteInputError)) throw error;
		if (error.code === 'no_account' || error.code === 'no_release') {
			throw new ApiError('not_built', error.message);
		}
		throw new ApiError('unprocessable', error.message, { reason: error.code });
	}
	// the new site keeps the admin account the database brings, so only the owner token is read
	const ownerToken = engineInput.firstRun?.reads?.ownerToken;
	if (engineInput.firstRun === undefined || ownerToken === undefined) {
		throw refusal('unsupported_kind', 'This kind of site cannot be imported');
	}
	const { restoreCeilingBytes, waitMs, pollMs } = backupServices();
	const params: SiteImportInput = {
		operationId,
		orgId: input.orgId,
		credentialId: input.credentialId,
		root: record.root,
		dossier: {
			importable: dossier.importable,
			estimateBytes: dossier.estimate.bytes,
			fileCount: dossier.estimate.fileCount
		},
		create: {
			...engineInput,
			firstRun: { ...engineInput.firstRun, reads: { ownerToken } }
		},
		waitMs,
		pollMs,
		restoreCeilingBytes
	};
	const plan = planSiteImport(params);
	const now = nowUtc().toMillis();
	const { operation, created } = await createSiteOperation(
		db,
		{
			id: targetId,
			organizationId: input.orgId,
			name: input.name,
			kind,
			category: engineInput.site.category,
			plane: 'managed',
			config: engineInput.site.config,
			primaryHostname: engineInput.hostname,
			now
		},
		{
			id: operationId,
			organizationId: input.orgId,
			accountId: engineInput.site.accountId,
			siteId: targetId,
			type: 'site.import',
			status: 'planned',
			idempotencyKey: input.idempotencyKey,
			targetIds: plan.targetIds,
			preconditions: plan.preconditions,
			planDigest: await computePlanDigest(plan),
			blastRadius: plan.blastRadius,
			rollbackPoint: plan.rollbackPoint,
			verification: 'pending',
			budget: DEFAULT_CHANGE_BUDGET,
			steps: plan.steps,
			inputs: params,
			now
		}
	);
	if (!created) return operation;
	await custody.audit(input.orgId, {
		actor: input.actor,
		action: 'site.import',
		target: targetId,
		detail: { operationId, credentialId: input.credentialId, host: row.host }
	});
	try {
		return await startRecorded(
			services,
			db,
			input.orgId,
			operation,
			{
				workflow: 'site-import',
				id: operationId,
				params: params as unknown as Record<string, unknown>
			},
			'The import could not be started'
		);
	} catch (error) {
		// the engine never took it, so the hidden site is not kept
		await setSiteState(db, input.orgId, targetId, 'deleted', nowUtc().toMillis());
		throw error;
	}
}

// #endregion

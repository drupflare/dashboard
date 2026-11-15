import { newId } from '@contracts/common';
import type { OperationType } from '@contracts/operations';
import { z } from 'zod';
import {
	planConfigApply,
	refuseKey,
	revertChanges,
	type ConfigApplyInput,
	type ConfigChange
} from '../../../engine/src/workflows/config-apply';
import { ApiError } from '../../shared/errors';
import { type Action } from '../../shared/permissions';
import { toFields, validate } from '../../shared/site-config/form';
import {
	groupOf,
	KV_OVERRIDABLE_NAMES,
	SITE_CONFIG_REGISTRY
} from '../../shared/site-config/registry';
import { isSecret, maskSecret, secretDigest } from '../../shared/site-config/secrets';
import { CONFIG_GROUP_LABELS } from '../../shared/site-config/view';
import {
	getConfigChange,
	listConfigChanges,
	listOperationChanges,
	type ConfigChangeRecord
} from '../db/repos/config-changes';
import { getOperationByKey, type StoredOperation } from '../db/repos/operations';
import { getReadySite } from '../db/repos/sites';
import type { Principal } from '../domain/authorize';
import { newOperation, startAndReturn } from './backups';
import { principalActor } from './owner-tokens';
import { freshDocument, type SiteSettingsServices } from './site-settings';

export const settingChangeSchema = z.strictObject({
	key: z.string().min(1).max(64),
	value: z.union([z.string().max(10_000), z.number(), z.null()])
});

export interface SettingsActor {
	principal: Principal;
	// the actions the principal holds on this site, from permittedActions
	permitted: readonly Action[];
	// the principal holds an owner role in the organisation
	owner: boolean;
}

const notFound = () => new ApiError('not_found', 'Not found');

// the group of every key must be one the principal may write; the first that is not stops the call
function assertWritable(keys: readonly string[], actor: SettingsActor): void {
	const permitted = new Set(actor.permitted);
	for (const key of keys) {
		const group = groupOf(key);
		if (!permitted.has(`site.config.${group}.write`)) {
			throw new ApiError(
				'forbidden',
				`Your role cannot change ${CONFIG_GROUP_LABELS[group].toLowerCase()} settings.`,
				{ reason: 'group_not_writable', group, key }
			);
		}
	}
}

async function startApply(
	services: SiteSettingsServices,
	input: {
		orgId: string;
		siteId: string;
		actor: SettingsActor;
		changes: ConfigChange[];
		// the etag of the settings the caller read; null on a revert, which reads its own
		etag: string | null;
		reverts?: string[];
		idempotencyKey: string;
		type?: OperationType;
	}
): Promise<StoredOperation> {
	const db = await services.getDb();
	const site = await getReadySite(db, input.orgId, input.siteId);
	if (site === null) throw notFound();
	// a repeat of a start that landed answers with that operation, whatever the site holds now
	const earlier = await getOperationByKey(db, input.orgId, input.idempotencyKey);
	if (earlier !== null) return earlier;
	if (site.kind !== 'drupal') {
		throw new ApiError('unprocessable', 'This site does not take setting changes here.', {
			reason: 'not_writable_here'
		});
	}
	if (site.state !== 'active' || site.accountId === null) {
		throw new ApiError('unprocessable', 'The site is not active', {
			reason: 'site_not_active'
		});
	}
	const keys = input.changes.map((change) => change.key);
	if (new Set(keys).size !== keys.length) {
		throw new ApiError('validation', 'A setting appears twice in the change.');
	}
	for (const key of keys) {
		const refusal = refuseKey(key, input.actor.owner);
		if (refusal !== null) {
			throw new ApiError('unprocessable', refusal.message, { reason: refusal.code, key });
		}
	}
	assertWritable(keys, input.actor);

	const doc = await freshDocument(services, site, input.actor.principal);
	if (doc === null) {
		throw new ApiError('unprocessable', 'The site did not answer, so nothing was changed.', {
			reason: 'site_unreachable'
		});
	}
	const verdict = validate(
		toFields(doc.settings, 'site-admin'),
		Object.fromEntries(input.changes.map((change) => [change.key, change.value]))
	);
	if (!verdict.ok) {
		throw new ApiError('unprocessable', 'One or more settings have a value the site refuses.', {
			reason: 'setting_invalid',
			// a message about a secret never carries what was sent or what the site holds
			errors: verdict.errors.map((error) =>
				isSecret(error.key)
					? { key: error.key, message: 'This value is not valid.' }
					: error
			)
		});
	}
	const current = Object.fromEntries(keys.map((key) => [key, doc.settings.values[key] ?? null]));
	if (input.etag !== null && input.etag !== doc.settings.etag) {
		throw new ApiError(
			'conflict',
			'These settings changed on the site after you opened them.',
			{
				reason: 'settings_changed',
				etag: doc.settings.etag,
				current: Object.fromEntries(
					Object.entries(current).map(([key, value]) => [key, maskSecret(key, value)])
				)
			}
		);
	}
	// the engine compares a secret by its digest, so no operation holds the value it read
	const expected = Object.fromEntries(
		await Promise.all(
			Object.entries(current).map(async ([key, value]) => [
				key,
				isSecret(key) ? await secretDigest(value) : value
			])
		)
	);

	const operationId = newId('op');
	const params: ConfigApplyInput = {
		operationId,
		orgId: input.orgId,
		siteId: site.id,
		accountId: site.accountId,
		actor: principalActor(input.actor.principal),
		owner: input.actor.owner,
		changes: input.changes,
		expected,
		...(input.reverts !== undefined ? { reverts: input.reverts } : {})
	};
	const { operation, created } = await newOperation(db, {
		id: operationId,
		orgId: input.orgId,
		accountId: site.accountId,
		siteId: site.id,
		type: 'config.apply',
		plan: planConfigApply(params),
		idempotencyKey: input.idempotencyKey,
		// the record keeps a digest in place of a secret; only the engine start carries the value
		inputs: {
			...params,
			changes: await Promise.all(
				params.changes.map(async (change) =>
					isSecret(change.key)
						? { key: change.key, value: await secretDigest(change.value) }
						: change
				)
			)
		}
	});
	if (!created) return operation;
	await services.audit(input.orgId, {
		actor: params.actor,
		action: input.reverts === undefined ? 'site.config.write' : 'site.config.revert',
		target: site.id,
		detail: { operationId, keys }
	});
	return startAndReturn(
		services,
		db,
		operation,
		{
			workflow: 'config-apply',
			id: operationId,
			params: params as unknown as Record<string, unknown>
		},
		input.orgId
	);
}

export function applySettings(
	services: SiteSettingsServices,
	input: {
		orgId: string;
		siteId: string;
		actor: SettingsActor;
		changes: ConfigChange[];
		etag: string;
		idempotencyKey: string;
	}
): Promise<StoredOperation> {
	return startApply(services, input);
}

export async function listSettingsHistory(
	services: SiteSettingsServices,
	input: {
		orgId: string;
		siteId: string;
		after?: { createdAt: number; id: string };
		count: number;
		// the actions the principal holds on this site; only keys of a readable group are listed
		permitted: readonly Action[];
	}
): Promise<ConfigChangeRecord[]> {
	const db = await services.getDb();
	if ((await getReadySite(db, input.orgId, input.siteId)) === null) throw notFound();
	const allowed = new Set(input.permitted);
	const keys = [
		...new Set([...KV_OVERRIDABLE_NAMES, ...Object.keys(SITE_CONFIG_REGISTRY)])
	].filter((key) => allowed.has(`site.config.${groupOf(key)}.read`));
	return listConfigChanges(db, input.orgId, input.siteId, {
		after: input.after,
		count: input.count,
		keys
	});
}

// every key the same apply changed goes back together, each to what it held before that apply
export async function revertSettings(
	services: SiteSettingsServices,
	input: {
		orgId: string;
		siteId: string;
		changeId: string;
		actor: SettingsActor;
		idempotencyKey: string;
	}
): Promise<StoredOperation> {
	const db = await services.getDb();
	const change = await getConfigChange(db, input.orgId, input.siteId, input.changeId);
	if (change === null) throw notFound();
	if (change.revertedBy !== null) {
		throw new ApiError('conflict', 'This change was already reverted.', {
			reason: 'already_reverted'
		});
	}
	if (change.status !== 'applied' && change.status !== 'unverified') {
		throw new ApiError(
			'unprocessable',
			'Only a change that reached the site can be reverted.',
			{
				reason: 'not_revertable'
			}
		);
	}
	const siblings = (
		await listOperationChanges(db, input.orgId, input.siteId, change.operationId)
	).filter(
		(row) =>
			row.revertedBy === null && (row.status === 'applied' || row.status === 'unverified')
	);
	if (siblings.some((row) => isSecret(row.key))) {
		throw new ApiError('unprocessable', 'A secret cannot be restored from the history.', {
			reason: 'secret_not_revertable'
		});
	}
	return startApply(services, {
		orgId: input.orgId,
		siteId: input.siteId,
		actor: input.actor,
		changes: revertChanges(siblings),
		etag: null,
		reverts: siblings.map((row) => row.id),
		idempotencyKey: input.idempotencyKey
	});
}

export const settingChangeView = z.strictObject({
	id: z.string(),
	operationId: z.string(),
	key: z.string(),
	label: z.string(),
	before: z.unknown(),
	after: z.unknown(),
	actor: z.string(),
	status: z.enum(['pending', 'applied', 'unverified', 'failed']),
	createdAt: z.string(),
	reverted: z.boolean(),
	revertable: z.boolean()
});
export type SettingChangeView = z.infer<typeof settingChangeView>;

export function toSettingChangeView(
	row: ConfigChangeRecord,
	label: (key: string) => string
): SettingChangeView {
	const before = JSON.parse(row.before) as { value: unknown; source: string };
	return {
		id: row.id,
		operationId: row.operationId,
		key: row.key,
		label: label(row.key),
		before: maskSecret(row.key, before.value ?? null),
		after: maskSecret(row.key, JSON.parse(row.after) as unknown),
		actor: row.actor,
		status: row.status,
		createdAt: new Date(row.createdAt).toISOString(),
		reverted: row.revertedBy !== null,
		revertable:
			row.revertedBy === null && (row.status === 'applied' || row.status === 'unverified')
	};
}

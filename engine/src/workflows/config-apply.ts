import type { Plan } from '@contracts/operations';
import { toFields, validate, type FieldDescriptor } from '../../../src/shared/site-config/form';
import { propertySchema, valueOf } from '../../../src/shared/site-config/levers';
import {
	groupOf,
	isKvWritable,
	isOwnerOnly,
	SITE_CONFIG_REGISTRY
} from '../../../src/shared/site-config/registry';
import { isSecret, maskSecret, secretDigest } from '../../../src/shared/site-config/secrets';
import { configChangeId, revertValue, type ConfigBefore } from '../config-rows';
import { buildPlan, setRollbackPoint, setVerification, transition } from '../operations/state';
import type { ConfigChangeRecord, ConfigDeps, SettingLever } from '../ports';
import { PermanentError, StepFailed, type StepRunner } from '../step';
import { assertOperationOrg, openSite } from './backup-create';
import {
	acquireLease,
	closeFailed,
	describeFailure,
	fenced,
	finishSuccess,
	plainStep,
	releaseLease,
	runStep,
	startOperation,
	type Ctx,
	type Outcome
} from './common';

export interface ConfigChange {
	key: string;
	// null or an empty string clears the override, so the deployed value applies again
	value: string | number | null;
}

export interface ConfigApplyInput {
	operationId: string;
	orgId: string;
	siteId: string;
	accountId: string;
	actor: string;
	// the caller is an owner of the organisation, which the owner-only settings need
	owner: boolean;
	changes: ConfigChange[];
	// the values the caller read just before, by key; a different value now means someone else changed it
	expected: Record<string, unknown>;
	// sent as If-Match when the site served the document the caller read
	ifMatch?: string | null;
	// the history rows this apply undoes
	reverts?: string[];
}

export function planConfigApply(input: Pick<ConfigApplyInput, 'siteId' | 'changes'>): Plan {
	const count = input.changes.length;
	return buildPlan({
		type: 'config.apply',
		targetIds: [input.siteId],
		preconditions: [
			`${input.siteId} is active and has an owner token`,
			`${count} setting${count === 1 ? '' : 's'} to change`
		],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'check', name: 'Check the settings against a fresh read' },
			{ id: 'write', name: 'Write the settings to the site' },
			{ id: 'verify', name: 'Read the settings back' },
			{ id: 'record', name: 'Record the change' }
		]
	});
}

// the keys no apply may touch, whatever the caller's permissions say
export function refuseKey(key: string, owner: boolean): PermanentError | null {
	if (key.toUpperCase() === 'PLAN') {
		return new PermanentError('plan_not_writable', 'The platform sets the plan.');
	}
	if (!isKvWritable(key)) {
		return new PermanentError('not_overridable', `${key} is set at deploy time.`);
	}
	if (isOwnerOnly(key) && !owner) {
		return new PermanentError('owner_only', `${key} can only be changed by an owner.`);
	}
	return null;
}

// the registry describes each lever; the group checks happen before an operation starts
export function fieldsOf(levers: readonly SettingLever[]): FieldDescriptor[] {
	const schema: Record<string, Record<string, unknown>> = {};
	const values: Record<string, unknown> = {};
	const provenance: Record<string, 'kv' | 'var' | 'default'> = {};
	const writable: Record<string, 'kv'> = {};
	for (const lever of levers) {
		const meta = SITE_CONFIG_REGISTRY[lever.name];
		schema[lever.name] = propertySchema(lever.name, lever.domain, groupOf(lever.name), meta);
		values[lever.name] = valueOf(lever);
		provenance[lever.name] = lever.source;
		if (isKvWritable(lever.name)) writable[lever.name] = 'kv';
	}
	return toFields({ schema, values, provenance, writable, etag: 'engine' }, 'site-admin');
}

// null and an empty string both mean no override
const normal = (value: unknown): string | number | null =>
	value === null || value === undefined || String(value).trim() === ''
		? null
		: typeof value === 'number'
			? value
			: String(value).trim();

const sameValue = (a: unknown, b: unknown) =>
	JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// a set value holds when the site reports it as an override; a cleared one when no override is left
function holds(lever: SettingLever | undefined, after: unknown): boolean {
	if (lever === undefined) return false;
	if (after === null) return lever.source !== 'kv';
	return lever.source === 'kv' && lever.value === String(after).trim();
}

// the value the caller asked for, read from the input so a secret never has to sit in a history row
const desiredOf = (input: ConfigApplyInput, key: string) =>
	normal(input.changes.find((change) => change.key === key)?.value);

const byName = (levers: readonly SettingLever[]) => new Map(levers.map((l) => [l.name, l]));

interface Checked {
	hostname: string;
	ownerTokenId: string;
	rows: ConfigChangeRecord[];
}

async function checkStep(ctx: Ctx, deps: ConfigDeps, input: ConfigApplyInput): Promise<Checked> {
	return runStep(ctx, 'check', 'check', async () => {
		await fenced(ctx);
		await assertOperationOrg(deps, ctx.operationId, input.orgId, 'site_not_ready');
		const open = await openSite(
			deps,
			{ id: input.siteId, orgId: input.orgId, accountId: input.accountId },
			{ notReady: 'site_not_ready', foreign: 'site_not_ready' }
		);
		const here = { hostname: open.hostname, ownerTokenId: open.ownerTokenId };
		// a replay finds the first reading, so a kill after the rows landed changes nothing
		const kept = await deps.changes.forOperation(input.orgId, input.operationId);
		if (kept.length > 0) return { ...here, rows: kept };

		for (const change of input.changes) {
			const refusal = refuseKey(change.key, input.owner);
			if (refusal !== null) throw refusal;
		}
		const levers = await deps.custody.withOwnerToken(
			input.siteId,
			open.ownerTokenId,
			(bearer) => deps.settings.read(open.hostname, { bearer })
		);
		const asked = Object.fromEntries(input.changes.map((c) => [c.key, normal(c.value)]));
		const verdict = validate(fieldsOf(levers), asked);
		if (!verdict.ok) {
			const first = verdict.errors[0]!;
			// a secret's message never carries a value, whatever the schema says
			const message = isSecret(first.key) ? 'This value is not valid.' : first.message;
			throw new PermanentError('setting_invalid', `${first.key}: ${message}`);
		}
		const known = byName(levers);
		const rows: ConfigChangeRecord[] = [];
		for (const change of input.changes) {
			const lever = known.get(change.key)!;
			const current = valueOf(lever);
			const held = isSecret(change.key) ? await secretDigest(current) : current;
			if (!sameValue(held, input.expected[change.key] ?? null)) {
				throw new PermanentError(
					'settings_changed',
					`${change.key} changed on the site after it was read`
				);
			}
			const after = asked[change.key] ?? null;
			if (holds(lever, after)) continue;
			const before: ConfigBefore = {
				value: maskSecret(change.key, current),
				source: lever.source
			};
			rows.push({
				id: configChangeId(input.operationId, change.key),
				organizationId: input.orgId,
				siteId: input.siteId,
				operationId: input.operationId,
				key: change.key,
				before: JSON.stringify(before),
				after: JSON.stringify(maskSecret(change.key, after)),
				actor: input.actor,
				status: 'pending',
				createdAt: deps.now(),
				revertedBy: null
			});
		}
		if (rows.length === 0) {
			throw new PermanentError('nothing_to_change', 'Those values are already in force.');
		}
		await deps.changes.begin(rows);
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.rollbackPoint === null
				? setRollbackPoint(operation, `settings:${ctx.operationId}`, deps.now())
				: operation
		);
		return { ...here, rows };
	});
}

async function writeStep(
	ctx: Ctx,
	deps: ConfigDeps,
	input: ConfigApplyInput,
	checked: Checked
): Promise<number> {
	return runStep(ctx, 'write', 'write', async () => {
		await fenced(ctx);
		return deps.custody.withOwnerToken(input.siteId, checked.ownerTokenId, async (bearer) => {
			const auth = { bearer };
			const known = byName(await deps.settings.read(checked.hostname, auth));
			// a run that died after the site took the write finds the values in force and sends nothing
			const pending = checked.rows.filter(
				(row) => !holds(known.get(row.key), desiredOf(input, row.key))
			);
			if (pending.length === 0) return 0;
			const patch = Object.fromEntries(
				pending.map((row) => [row.key, desiredOf(input, row.key) as unknown])
			);
			const answer = await deps.settings.write(
				checked.hostname,
				patch,
				auth,
				input.ifMatch ?? null
			);
			if (answer.invalid.length > 0) {
				const first = answer.invalid[0]!;
				const reason = isSecret(first.name) ? 'This value is not valid.' : first.reason;
				throw new PermanentError('setting_invalid', `${first.name}: ${reason}`);
			}
			if (answer.refused.length > 0) {
				throw new PermanentError('not_overridable', `${answer.refused.join(', ')} refused`);
			}
			return pending.length;
		});
	});
}

async function verifyStep(
	ctx: Ctx,
	deps: ConfigDeps,
	input: ConfigApplyInput,
	checked: Checked
): Promise<void> {
	await runStep(ctx, 'verify', 'verify', async () => {
		await fenced(ctx);
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.status === 'running'
				? transition(operation, 'verifying', deps.now())
				: operation
		);
		const known = byName(
			await deps.custody.withOwnerToken(input.siteId, checked.ownerTokenId, (bearer) =>
				deps.settings.read(checked.hostname, { bearer })
			)
		);
		const off = checked.rows.filter(
			(row) => !holds(known.get(row.key), desiredOf(input, row.key))
		);
		if (off.length > 0) {
			await deps.changes.settle(input.orgId, ctx.operationId, 'unverified');
			await deps.store.mutate(ctx.operationId, (operation) =>
				setVerification(operation, 'failed', deps.now())
			);
			throw new PermanentError(
				'verify_failed',
				`the site does not report ${off.map((row) => row.key).join(', ')} as written`
			);
		}
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.verification === 'passed'
				? operation
				: setVerification(operation, 'passed', deps.now())
		);
	});
}

async function recordStep(ctx: Ctx, deps: ConfigDeps, input: ConfigApplyInput): Promise<void> {
	await runStep(ctx, 'record', 'record', async () => {
		await fenced(ctx);
		await deps.changes.settle(input.orgId, ctx.operationId, 'applied');
		await deps.changes.markReverted(input.orgId, input.reverts ?? [], ctx.operationId);
	});
}

// the values a revert writes: each row's before, as an override only when it was one
export function revertChanges(rows: readonly Pick<ConfigChangeRecord, 'key' | 'before'>[]) {
	return rows.map((row) => ({
		key: row.key,
		value: revertValue(row.before) as ConfigChange['value']
	}));
}

export async function runConfigApply(
	step: StepRunner,
	deps: ConfigDeps,
	input: ConfigApplyInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.siteId,
		accountId: input.accountId,
		purpose: 'config.apply',
		epoch: null
	};
	let written = 0;
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		const checked = await checkStep(ctx, deps, input);
		written = await writeStep(ctx, deps, input, checked);
		await verifyStep(ctx, deps, input, checked);
		await recordStep(ctx, deps, input);
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		const reason = describeFailure(error);
		const closed = await closeFailed(ctx, error);
		// rows still pending never reached the site; a verify failure already marked its own
		await plainStep(ctx, 'mark.failed', () =>
			deps.changes.settle(input.orgId, input.operationId, 'failed')
		);
		await releaseLease(ctx);
		return closed === 'cancelled'
			? { status: 'cancelled', reason }
			: { status: 'failed', reason, leaked: [] };
	}
	await finishSuccess(
		ctx,
		written === 0
			? `the settings of ${input.siteId} were already in force`
			: `${written} settings of ${input.siteId} were written and read back`
	);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}

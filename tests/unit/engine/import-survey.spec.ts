import { describe, expect, it } from 'vitest';
import { readSurveyCursor } from '../../../engine/src/import-parts';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import {
	planImportSurvey,
	runImportSurvey,
	type ImportSurveyInput
} from '../../../engine/src/workflows/import-survey';
import { makeRunner, makeWorld } from './fakes';
import {
	credentialRows,
	DAY_MS,
	fakeSource,
	fakeSurveyConnector,
	importDepsOf,
	KEY_MARKER,
	ROOT,
	sealCredential
} from './import-fakes';

async function surveyWorld(options: { fingerprint?: string | null; failWith?: Error } = {}) {
	const world = await makeWorld();
	const now = world.clock.now();
	const credentialId = await sealCredential(world, {
		orgId: world.orgId,
		now,
		...(options.fingerprint === undefined ? {} : { fingerprint: options.fingerprint })
	});
	const surveyor = fakeSurveyConnector(options.failWith ?? null);
	const built = importDepsOf(world, {
		connector: fakeSource().connector,
		survey: surveyor.connector
	});
	const input: ImportSurveyInput = {
		operationId: world.operationId,
		orgId: world.orgId,
		credentialId,
		root: ROOT,
		ceilingBytes: 16 * 1024 * 1024,
		filesLandable: true
	};
	const frozen = await freezePlan(planImportSurvey(input));
	await world.store.begin({
		operation: newOperation({
			id: input.operationId,
			orgId: input.orgId,
			idempotencyKey: 'survey-1',
			frozen,
			verification: 'not-required',
			now
		}),
		accountId: null,
		siteId: null
	});
	return { world, input, surveyor, ...built };
}

type Sw = Awaited<ReturnType<typeof surveyWorld>>;

const run = async (sw: Sw) => {
	const { runner } = makeRunner(new Map());
	return runImportSurvey(runner, sw.deps, sw.input);
};

const operationOf = async (sw: Sw) => (await sw.world.store.get(sw.world.operationId))!;

describe('a survey', () => {
	it('leaves the dossier in the operation cursor and succeeds', async () => {
		const sw = await surveyWorld();
		expect(await run(sw)).toEqual({ status: 'succeeded' });
		const operation = await operationOf(sw);
		expect(operation.status).toBe('succeeded');
		const record = readSurveyCursor(operation.cursor);
		expect(record).toMatchObject({ v: 1, root: ROOT });
		expect(record!.dossier.verdict).toBe('ready');
		expect(record!.dossier.importable).toBe(true);
	});

	it('keeps the key, so the import that follows can use it', async () => {
		const sw = await surveyWorld();
		await run(sw);
		expect(credentialRows(sw.world)).toHaveLength(1);
	});

	it('sends the server only read commands and closes the session', async () => {
		const sw = await surveyWorld();
		await run(sw);
		expect(sw.surveyor.sessions).toHaveLength(1);
		expect(sw.surveyor.sessions[0]!.closed).toBe(true);
		for (const command of sw.surveyor.sessions[0]!.commands) {
			expect(command).not.toMatch(/\b(rm|mv|cp|tee|chmod|drop|delete|truncate)\b/i);
		}
	});

	it('keeps the key out of the cursor, the operation rows and the outcome', async () => {
		const sw = await surveyWorld();
		const outcome = await run(sw);
		const text = JSON.stringify({
			outcome,
			operations: sw.world.sqlite.prepare('SELECT * FROM operations').all(),
			steps: sw.world.sqlite.prepare('SELECT * FROM operation_steps').all()
		});
		expect(text).not.toContain(KEY_MARKER);
		expect(text).not.toContain('PRIVATE KEY');
	});
});

describe('a refused survey', () => {
	it('fails without a command when the host key is not the confirmed one', async () => {
		const sw = await surveyWorld();
		sw.world.sqlite
			.prepare('UPDATE import_credentials SET host_key_fingerprint = ?')
			.run('SHA256:x');
		const outcome = await run(sw);
		expect(outcome).toMatchObject({ status: 'failed' });
		expect(sw.surveyor.sessions[0]!.commands).toEqual([]);
		expect((await operationOf(sw)).status).toBe('failed');
		expect(JSON.stringify(outcome)).not.toContain(KEY_MARKER);
	});

	it('fails with a plain code when the host key was never confirmed', async () => {
		const sw = await surveyWorld({ fingerprint: null });
		const outcome = await run(sw);
		expect(outcome).toMatchObject({ status: 'failed' });
		expect(outcome.status === 'failed' ? outcome.reason : '').toContain('host_key_unconfirmed');
		expect(sw.surveyor.sessions).toEqual([]);
	});

	it('fails when the key expired', async () => {
		const sw = await surveyWorld();
		sw.world.clock.advance(DAY_MS + 1);
		const outcome = await run(sw);
		expect(outcome.status === 'failed' ? outcome.reason : '').toContain('credential_expired');
		expect(sw.surveyor.sessions).toEqual([]);
	});

	it('names an auth refusal without echoing what the server said', async () => {
		const sw = await surveyWorld({
			failWith: Object.assign(new Error(`Permission denied ${KEY_MARKER}`), {
				name: 'AuthError'
			})
		});
		const outcome = await run(sw);
		expect(outcome.status === 'failed' ? outcome.reason : '').toContain('source_auth_failed');
		expect(JSON.stringify(outcome)).not.toContain(KEY_MARKER);
		expect(JSON.stringify(await operationOf(sw))).not.toContain(KEY_MARKER);
	});

	it('names an unreachable server', async () => {
		const sw = await surveyWorld({ failWith: new Error('connect ECONNREFUSED') });
		const outcome = await run(sw);
		expect(outcome.status === 'failed' ? outcome.reason : '').toContain('source_unreachable');
	});
});

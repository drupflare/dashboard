import { clearNuxtState } from '#app';
import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ImportPage from '~/pages/new/import.vue';
import NewPage from '~/pages/new/index.vue';
import { IMPORT_ROUTE_REFUSALS } from '~/shared/operation-copy';
import { useImportsStore } from '~/stores/imports';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi, type Reply } from '../stores/store-support';

const personal = { id: 'org_personal', name: 'Personal', personal: true, role: 'owner' };
const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};
const base = `/api/v1/orgs/${personal.id}`;
const credentialKey = `POST ${base}/imports/credentials`;
const hostKeyKey = `POST ${base}/imports/hostkey`;
const surveyKey = `POST ${base}/imports/survey`;
const importKey = `POST ${base}/imports`;
const surveyOpKey = `GET ${base}/operations/op_survey`;
const templatesKey = 'GET /api/v1/templates';

const credential = {
	id: 'imc_1',
	publicKey: 'ssh-ed25519 AAAATESTKEY drupflare-import',
	host: 'files.example.test',
	port: 22,
	username: 'drupal',
	expiresAt: '2026-11-14T00:00:00.000Z'
};
const hostKey = {
	credentialId: 'imc_1',
	hostKeyType: 'ssh-ed25519',
	fingerprint: 'SHA256:TESTFINGERPRINT',
	confirmed: false
};
const readyDossier = {
	verdict: 'ready',
	importable: true,
	refusals: [] as string[],
	estimate: { bytes: 3145728, fileCount: 12 },
	findings: [
		{ status: 'automatic', title: 'Content', detail: 'Nodes and users carry over' },
		{ status: 'requires choice', title: 'Redis', detail: 'Choose whether to keep the cache' }
	]
};

type Dossier = typeof readyDossier;

function surveyOperation(dossier: Dossier | null, status = 'succeeded') {
	return {
		id: 'op_survey',
		type: 'import.survey',
		status,
		steps: [],
		targetIds: [],
		cursor:
			dossier === null
				? null
				: JSON.stringify({
						v: 1,
						host: credential.host,
						root: '/var/www/html',
						capturedAt: '2026-11-13T00:00:00.000Z',
						dossier
					})
	};
}

const refusal = (status: number, reason: string) => ({
	status,
	body: { code: 'conflict', message: 'Refused', details: { reason }, requestId: 'req_7' }
});

let cleanup: () => void = () => undefined;
let hostKeyReply: (confirm: boolean) => Reply;
let startReply: () => Reply;
let dossier: Dossier | null;
let templatesReply: () => Reply;
const mounted: { unmount: () => void }[] = [];

beforeEach(async () => {
	clearBrowserState();
	clearNuxtState('onboarding-draft');
	useSessionStore().$reset();
	useOrgStore().$reset();
	useImportsStore().reset();
	dossier = readyDossier;
	hostKeyReply = (confirm) => ({ body: { ...hostKey, confirmed: confirm } });
	startReply = () => ({
		status: 202,
		body: { id: 'op_import', type: 'site.import', status: 'planned', steps: [], targetIds: [] }
	});
	templatesReply = () => ({ body: { items: [] } });
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': { body: { items: [personal], nextCursor: null } },
		[credentialKey]: { status: 201, body: credential },
		[hostKeyKey]: (call) => {
			const body = call.body as { confirm?: unknown };
			return hostKeyReply(body.confirm !== undefined);
		},
		[surveyKey]: { status: 202, body: surveyOperation(null, 'planned') },
		[surveyOpKey]: () => ({
			body: surveyOperation(dossier, dossier === null ? 'failed' : 'succeeded')
		}),
		[importKey]: () => startReply()
	});
	await useOrgStore().ensure();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

type Clickable = { text(): string; trigger(event: string): Promise<unknown> };

function buttonLabelled(wrapper: { findAll(selector: string): Clickable[] }, label: string) {
	return wrapper.findAll('button').find((b) => b.text().trim() === label);
}

async function clickButton(wrapper: { findAll(selector: string): Clickable[] }, label: string) {
	const button = buttonLabelled(wrapper, label);
	if (!button) throw new Error(`no button labelled ${label}`);
	await button.trigger('click');
}

type Mounted = Awaited<ReturnType<typeof mountImport>>;

async function mountImport() {
	const wrapper = await mountSuspended(ImportPage, { route: '/new/import' });
	mounted.push(wrapper);
	await waitForText(wrapper, 'Add the Server');
	return wrapper;
}

async function waitForText(wrapper: { text(): string }, text: string) {
	await vi.waitFor(() => expect(wrapper.text()).toContain(text));
}

async function fillServer(wrapper: Mounted) {
	await wrapper.find('#import-host').setValue('files.example.test');
	await wrapper.find('#import-user').setValue('drupal');
	await wrapper.find('#import-root').setValue('/var/www/html');
}

// a click on a submit button does not reach the form in this environment, so the form is submitted directly
async function submitForm(wrapper: Mounted) {
	await wrapper.find('form').trigger('submit');
}

async function createKey(wrapper: Mounted) {
	await fillServer(wrapper);
	await submitForm(wrapper);
	await waitForText(wrapper, credential.publicKey);
}

async function confirmHostKey(wrapper: Mounted) {
	await createKey(wrapper);
	await clickButton(wrapper, 'Next');
	await waitForText(wrapper, hostKey.fingerprint);
	await clickButton(wrapper, 'Confirm the Host Key');
}

describe('import from a server, the walk', () => {
	it('moves from the server form to a started import with each route called once', async () => {
		const wrapper = await mountImport();

		await createKey(wrapper);
		const create = calls.find((call) => call.path === `${base}/imports/credentials`);
		expect(create?.body).toEqual({ host: 'files.example.test', port: 22, username: 'drupal' });
		expect(wrapper.text()).toContain('authorized_keys');
		expect(wrapper.text()).toContain('24 hours');

		await clickButton(wrapper, 'Next');
		await waitForText(wrapper, 'Check this matches what your server reports');
		expect(wrapper.text()).toContain(hostKey.fingerprint);

		await clickButton(wrapper, 'Confirm the Host Key');
		await waitForText(wrapper, 'Ready to Import');
		const confirm = calls.filter((call) => call.path === `${base}/imports/hostkey`).at(-1);
		expect(confirm?.body).toEqual({
			credentialId: 'imc_1',
			confirm: { fingerprint: hostKey.fingerprint }
		});

		const survey = calls.find((call) => call.path === `${base}/imports/survey`);
		expect(survey?.body).toEqual({ credentialId: 'imc_1', root: '/var/www/html' });
		expect(survey?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
		expect(wrapper.text()).toContain('Estimated size: 3 MB. 12 files to copy.');
		expect(wrapper.text()).toContain('Carried Over Automatically');
		expect(wrapper.text()).toContain('Needs Your Choice');

		await clickButton(wrapper, 'Next');
		await wrapper.find('#site-name').setValue('quiet-oak-harbor');
		await submitForm(wrapper);
		await vi.waitFor(() =>
			expect(calls.some((call) => call.path === `${base}/imports`)).toBe(true)
		);

		const start = calls.find((call) => call.path === `${base}/imports`);
		expect(start?.body).toEqual({
			credentialId: 'imc_1',
			surveyId: 'op_survey',
			name: 'quiet-oak-harbor'
		});
		expect(start?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('starts on the server form with no key and no Next button', async () => {
		const wrapper = await mountImport();

		expect(wrapper.find('#import-host').exists()).toBe(true);
		expect(buttonLabelled(wrapper, 'Next')).toBeUndefined();
		expect(calls.some((call) => call.path === `${base}/imports/credentials`)).toBe(false);
	});

	it('shows a plain sentence beside the server form for a refused address', async () => {
		cleanup();
		cleanup = registerApi({
			'GET /api/v1/me': { body: me },
			'GET /api/v1/me/organizations': { body: { items: [personal], nextCursor: null } },
			[credentialKey]: () => refusal(422, 'host_private')
		});
		await useOrgStore().ensure();
		const wrapper = await mountImport();

		await fillServer(wrapper);
		await wrapper.find('#import-host').setValue('10.0.0.4');
		await submitForm(wrapper);
		await waitForText(wrapper, IMPORT_ROUTE_REFUSALS.host_private!);
		expect(wrapper.find('[role="alert"]').text()).toContain(
			IMPORT_ROUTE_REFUSALS.host_private!
		);
		expect(wrapper.text()).not.toContain('SHA256');
	});
});

describe('import from a server, the host key', () => {
	it('stops on a changed host key with a fresh start and no way to continue', async () => {
		hostKeyReply = (confirm) =>
			confirm ? refusal(409, 'host_key_changed') : { body: { ...hostKey, confirmed: false } };
		const wrapper = await mountImport();
		await confirmHostKey(wrapper);

		await waitForText(wrapper, IMPORT_ROUTE_REFUSALS.host_key_changed!);
		expect(buttonLabelled(wrapper, 'Start Over')).toBeDefined();
		expect(buttonLabelled(wrapper, 'Try Again')).toBeUndefined();
		expect(buttonLabelled(wrapper, 'Confirm the Host Key')).toBeUndefined();
		expect(calls.some((call) => call.path === `${base}/imports/survey`)).toBe(false);

		await clickButton(wrapper, 'Start Over');
		await waitForText(wrapper, 'Add the Server');
	});
});

describe('import from a server, the dossier', () => {
	it('has no Next button for a refused dossier and says what to change', async () => {
		dossier = {
			...readyDossier,
			verdict: 'refused',
			importable: false,
			refusals: ['The database holds a trigger, which a new site cannot store.'],
			findings: [{ status: 'unsupported', title: 'Triggers', detail: 'Found in the dump' }]
		};
		const wrapper = await mountImport();
		await confirmHostKey(wrapper);

		await waitForText(wrapper, 'Cannot Be Imported Yet');
		expect(wrapper.text()).toContain('The database holds a trigger');
		expect(wrapper.text()).toContain('Not Supported');
		expect(buttonLabelled(wrapper, 'Next')).toBeUndefined();
		expect(buttonLabelled(wrapper, 'Start Import')).toBeUndefined();
	});

	it('shows a failed check with a plain reason and a way to start it again', async () => {
		dossier = null;
		const wrapper = await mountImport();
		await confirmHostKey(wrapper);

		await waitForText(wrapper, 'Could Not Check the Server');
		expect(wrapper.text()).toContain('Stopped before it could finish.');
		expect(buttonLabelled(wrapper, 'Try Again')).toBeDefined();
	});
});

describe('import from a server, start refusals', () => {
	async function reachName(wrapper: Mounted) {
		await confirmHostKey(wrapper);
		await waitForText(wrapper, 'Ready to Import');
		await clickButton(wrapper, 'Next');
		await waitForText(wrapper, 'Start Import');
	}

	it('shows the sentence for an import that is already running', async () => {
		startReply = () => refusal(409, 'import_busy');
		const wrapper = await mountImport();
		await reachName(wrapper);

		await submitForm(wrapper);
		await waitForText(wrapper, IMPORT_ROUTE_REFUSALS.import_busy!);
		expect(wrapper.find('[role="alert"]').text()).toContain(IMPORT_ROUTE_REFUSALS.import_busy!);
	});

	it('shows the sentence for a plan that needs Drupflare to schedule the import', async () => {
		startReply = () => refusal(422, 'import_approval_needed');
		const wrapper = await mountImport();
		await reachName(wrapper);

		await submitForm(wrapper);
		await waitForText(wrapper, IMPORT_ROUTE_REFUSALS.import_approval_needed!);
		expect(wrapper.text()).not.toContain('import_approval_needed');
	});
});

describe('the import card on /new', () => {
	it('makes the import card choosable and leaves the other templates as they were', async () => {
		templatesReply = () => ({
			body: {
				items: [
					{
						id: 'drupal',
						name: 'Drupal',
						category: 'cms',
						free: true,
						enabled: true,
						comingSoon: null
					},
					{
						id: 'import',
						name: 'Import From a Server',
						category: 'cms',
						free: true,
						enabled: true,
						comingSoon: null
					}
				]
			}
		});
		cleanup();
		cleanup = registerApi({
			'GET /api/v1/me': { body: me },
			'GET /api/v1/me/organizations': { body: { items: [personal], nextCursor: null } },
			'GET /api/v1/orgs/org_personal/entitlement': {
				body: { planId: 'site', features: { customCode: true } }
			},
			[templatesKey]: () => templatesReply()
		});
		await useOrgStore().ensure();

		const wrapper = await mountSuspended(NewPage, { route: '/new' });
		mounted.push(wrapper);
		await waitForText(wrapper, 'Import From a Server');
		expect(wrapper.find<HTMLInputElement>('#template-import').element.disabled).toBe(false);
		expect(wrapper.find<HTMLInputElement>('#template-drupal').element.disabled).toBe(false);
	});
});

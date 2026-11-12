import { mockComponent, mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import Adopt from '~/components/site/Adopt.vue';
import { useSessionStore } from '~/stores/session';
import { useSitesStore } from '~/stores/sites';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

mockComponent('NuxtTurnstile', {
	props: { modelValue: String },
	setup(_props: unknown, { expose }: { expose: (value: object) => void }) {
		expose({ reset: () => undefined });
		return () => h('div');
	}
});

const navigate = vi.hoisted(() => vi.fn());
mockNuxtImport('navigateTo', () => navigate);

const ORG = 'org_personal';
const SITE = 'site_1';
const NAME = 'old-campus-site';
const path = `POST /api/v1/orgs/${ORG}/sites/${SITE}/adopt`;

const soon = () => new Date(Date.now() + 5 * 60 * 1000).toISOString();
const operation = {
	id: 'op_ado1',
	type: 'site.adopt',
	status: 'planned',
	targetIds: ['site_2', SITE]
};
const envelope = (status: number, code: string, message: string, details: object = {}) => ({
	status,
	body: { code, message, details, requestId: 'req_1' }
});

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

function signIn(stepUpUntil: string | null) {
	useSessionStore().me = {
		id: 'usr_1',
		email: 'owner@example.test',
		displayName: null,
		via: 'session',
		stepUpUntil
	};
}

async function mountAdopt() {
	const wrapper = await mountSuspended(Adopt, {
		props: { orgId: ORG, siteId: SITE, name: NAME },
		attachTo: document.body
	});
	mounted.push(wrapper);
	return wrapper;
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const inDialog = (text: string) =>
	[...(dialog()?.querySelectorAll('button') ?? [])].find(
		(button) => button.textContent?.trim() === text
	);

async function openDialog(wrapper: Awaited<ReturnType<typeof mountAdopt>>) {
	await wrapper.find('button').trigger('click');
	await vi.waitFor(() => expect(dialog()).not.toBeNull());
}

beforeEach(() => {
	navigate.mockReset();
	clearBrowserState();
	useSessionStore().$reset();
	useSitesStore().$reset();
	signIn(soon());
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	document.body.replaceChildren();
});

describe('adopt a site', () => {
	it('says what happens, that the copy is one way and that the source stays', async () => {
		cleanup = registerApi({ [path]: { status: 202, body: operation } });
		const wrapper = await mountAdopt();
		await openDialog(wrapper);
		const text = dialog()!.textContent ?? '';
		expect(text).toContain(`Move ${NAME} under managed operation.`);
		expect(text).toContain('is not changed or deleted');
		expect(text).toContain('The copy is one-way');
		expect(text).toContain('Uploaded files');
		expect(text).toContain('above 16 MiB');
		expect(calls).toHaveLength(0);
	});

	it('sends one request with a key and opens the progress screen', async () => {
		cleanup = registerApi({ [path]: { status: 202, body: operation } });
		const wrapper = await mountAdopt();
		await openDialog(wrapper);
		inDialog('Adopt Site')!.click();

		await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/new/progress/op_ado1'));
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
	});

	it.each([
		[409, 'conflict', 'already_adopted', 'This site was already adopted.'],
		[422, 'unprocessable', 'not_self_managed', 'Only a self-managed site can be adopted.'],
		[422, 'unprocessable', 'site_not_live', 'This site is not live, so it cannot be adopted.'],
		[
			409,
			'conflict',
			'site_busy',
			'Another change to this site is still running. Wait for it to finish, then try again.'
		],
		[403, 'forbidden', 'plan_full', 'Your plan has no room for another site.']
	])(
		'shows the plain reason for a %i %s refusal and keeps the dialog open',
		async (status, code, reason, text) => {
			cleanup = registerApi({ [path]: envelope(status, code, 'server words', { reason }) });
			const wrapper = await mountAdopt();
			await openDialog(wrapper);
			inDialog('Adopt Site')!.click();

			await vi.waitFor(() =>
				expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(text)
			);
			expect(navigate).not.toHaveBeenCalled();
			expect(dialog()).not.toBeNull();
		}
	);

	it('falls back to the server message for a reason it does not know', async () => {
		cleanup = registerApi({ [path]: envelope(422, 'unprocessable', 'Something specific') });
		const wrapper = await mountAdopt();
		await openDialog(wrapper);
		inDialog('Adopt Site')!.click();

		await vi.waitFor(() => expect(dialog()?.textContent).toContain('Something specific'));
	});

	it('asks for a fresh sign-in before it sends anything when the session is stale', async () => {
		signIn(null);
		cleanup = registerApi({ [path]: { status: 202, body: operation } });
		const wrapper = await mountAdopt();
		await openDialog(wrapper);
		inDialog('Adopt Site')!.click();

		await vi.waitFor(() => expect(dialog()?.textContent).toContain('Confirm Your Identity'));
		expect(calls).toHaveLength(0);
	});

	it('asks for a fresh sign-in when the server says the step-up has lapsed', async () => {
		cleanup = registerApi({
			[path]: envelope(403, 'forbidden', 'This action needs a fresh sign-in', {
				requires: 'step-up'
			})
		});
		const wrapper = await mountAdopt();
		await openDialog(wrapper);
		inDialog('Adopt Site')!.click();

		await vi.waitFor(() => expect(dialog()?.textContent).toContain('Confirm Your Identity'));
		expect(navigate).not.toHaveBeenCalled();
	});

	it('closes with Cancel and sends nothing', async () => {
		cleanup = registerApi({ [path]: { status: 202, body: operation } });
		const wrapper = await mountAdopt();
		await openDialog(wrapper);
		inDialog('Cancel')!.click();

		await vi.waitFor(() => expect(dialog()).toBeNull());
		expect(calls).toHaveLength(0);
	});
});

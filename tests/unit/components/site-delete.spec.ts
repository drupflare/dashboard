import { mockComponent, mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import Delete from '~/components/site/Delete.vue';
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
const NAME = 'quiet-oak-harbor';
const path = `DELETE /api/v1/orgs/${ORG}/sites/${SITE}`;

const soon = () => new Date(Date.now() + 5 * 60 * 1000).toISOString();
const operation = { id: 'op_del1', type: 'site.delete', status: 'planned', targetIds: [SITE] };
const envelope = (status: number, code: string, message: string) => ({
	status,
	body: { code, message, details: {}, requestId: 'req_1' }
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

async function mountDelete() {
	const wrapper = await mountSuspended(Delete, {
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

async function openDialog(wrapper: Awaited<ReturnType<typeof mountDelete>>) {
	await wrapper.find('button').trigger('click');
	await vi.waitFor(() => expect(dialog()).not.toBeNull());
}

async function type(text: string) {
	const input = dialog()!.querySelector<HTMLInputElement>('input[type="text"]')!;
	input.value = text;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await nextTick();
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

describe('delete a site', () => {
	it('says what happens before it asks for the name', async () => {
		cleanup = registerApi({ [path]: { status: 202, body: operation } });
		const wrapper = await mountDelete();
		await openDialog(wrapper);
		const text = dialog()!.textContent ?? '';
		expect(text).toContain(`This deletes ${NAME}.`);
		expect(text).toContain('stops serving');
		expect(text).toContain('reserved for 90 days');
		expect(text).toContain('Backups are kept');
		expect(text).toContain('no undo');
	});

	it('keeps Delete Site disabled until the name matches, then sends the confirm text and opens the progress screen', async () => {
		cleanup = registerApi({ [path]: { status: 202, body: operation } });
		const wrapper = await mountDelete();
		await openDialog(wrapper);

		await type('quiet-oak');
		expect(inDialog('Delete Site')?.hasAttribute('disabled')).toBe(true);
		await type(NAME);
		expect(inDialog('Delete Site')?.hasAttribute('disabled')).toBe(false);

		inDialog('Delete Site')!.click();
		await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/new/progress/op_del1'));
		expect(calls).toHaveLength(1);
		expect(calls[0]?.body).toEqual({ confirm: NAME });
		expect(calls[0]?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('shows a refusal inside the dialog and keeps it open', async () => {
		cleanup = registerApi({
			[path]: envelope(409, 'conflict', 'Another change to this site is still running')
		});
		const wrapper = await mountDelete();
		await openDialog(wrapper);
		await type(NAME);
		inDialog('Delete Site')!.click();

		await vi.waitFor(() =>
			expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
				'Another change to this site is still running'
			)
		);
		expect(navigate).not.toHaveBeenCalled();
		expect(dialog()).not.toBeNull();
	});

	it('shows the name mismatch the server reports', async () => {
		cleanup = registerApi({
			[path]: envelope(422, 'unprocessable', 'The name you typed does not match this site')
		});
		const wrapper = await mountDelete();
		await openDialog(wrapper);
		await type(NAME);
		inDialog('Delete Site')!.click();

		await vi.waitFor(() =>
			expect(dialog()?.textContent).toContain('The name you typed does not match this site')
		);
		expect(navigate).not.toHaveBeenCalled();
	});

	it('asks for a fresh sign-in before it sends anything when the session is stale', async () => {
		signIn(null);
		cleanup = registerApi({ [path]: { status: 202, body: operation } });
		const wrapper = await mountDelete();
		await openDialog(wrapper);
		await type(NAME);
		inDialog('Delete Site')!.click();

		await vi.waitFor(() => expect(dialog()?.textContent).toContain('Confirm It Is You'));
		expect(calls).toHaveLength(0);
	});

	it('asks for a fresh sign-in when the server says the step-up has lapsed', async () => {
		cleanup = registerApi({
			[path]: {
				status: 403,
				body: {
					code: 'forbidden',
					message: 'This action needs a fresh sign-in',
					details: { requires: 'step-up' },
					requestId: 'req_2'
				}
			}
		});
		const wrapper = await mountDelete();
		await openDialog(wrapper);
		await type(NAME);
		inDialog('Delete Site')!.click();

		await vi.waitFor(() => expect(dialog()?.textContent).toContain('Confirm It Is You'));
		expect(navigate).not.toHaveBeenCalled();
	});

	it('closes on Cancel and puts focus back on the Delete Site button', async () => {
		cleanup = registerApi({ [path]: { status: 202, body: operation } });
		const wrapper = await mountDelete();
		const trigger = wrapper.find('button').element as HTMLButtonElement;
		await openDialog(wrapper);

		inDialog('Cancel')!.click();
		await vi.waitFor(() => expect(dialog()).toBeNull());
		await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
		expect(calls).toHaveLength(0);
	});
});

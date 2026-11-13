import { mockComponent, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import CreateDialog from '~/components/key/create/Dialog.vue';
import Scopes from '~/components/key/create/Scopes.vue';
import Revoke from '~/components/key/Revoke.vue';
import { claudeMcpAddCommand, type KeyView } from '~/shared/api-keys';
import { useApiKeysStore } from '~/stores/api-keys';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

mockComponent('NuxtTurnstile', {
	props: { modelValue: String },
	setup(_props: unknown, { expose }: { expose: (value: object) => void }) {
		expose({ reset: () => undefined });
		return () => h('div');
	}
});

const ORG = 'org_personal';
const createPath = `POST /api/v1/orgs/${ORG}/api-keys`;
const revokePath = (id: string) => `POST /api/v1/orgs/${ORG}/api-keys/${id}/revoke`;
const TOKEN = 'dfk_0123456789ab_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';

const key = (over: Partial<KeyView> = {}): KeyView => ({
	id: 'key_1',
	name: 'ci runner',
	prefix: 'dfk_0123456789ab',
	scopes: ['org.read'],
	createdAt: '2026-11-01T10:00:00.000Z',
	lastUsedAt: null,
	expiresAt: null,
	revokedAt: null,
	...over
});

const envelope = (status: number, message: string, details = {}) => ({
	status,
	body: {
		code: status === 403 ? 'forbidden' : 'validation',
		message,
		details,
		requestId: 'req_1'
	}
});

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];
const written: string[] = [];

function signIn(stepUpUntil: string | null) {
	useSessionStore().me = {
		id: 'usr_1',
		email: 'owner@example.test',
		displayName: null,
		via: 'session',
		stepUpUntil
	};
}

const soon = () => new Date(Date.now() + 5 * 60 * 1000).toISOString();
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const inDialog = (text: string) =>
	[...(dialog()?.querySelectorAll('button') ?? [])].find(
		(button) => button.textContent?.trim() === text
	);

async function typeInto(selector: string, text: string) {
	const input = dialog()!.querySelector<HTMLInputElement>(selector)!;
	input.value = text;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await nextTick();
}

async function tick(select: (input: HTMLInputElement) => boolean) {
	const input = [...dialog()!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
		select
	)!;
	input.checked = true;
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await nextTick();
}

const labelled = (text: string) => (input: HTMLInputElement) =>
	input.closest('label')?.textContent?.trim() === text;

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useApiKeysStore().$reset();
	written.length = 0;
	vi.stubGlobal('navigator', {
		clipboard: { writeText: async (text: string) => void written.push(text) }
	});
	signIn(soon());
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

describe('create a key', () => {
	const offered = ['org.read', 'site.read', 'key.read'];

	async function mountDialog() {
		const wrapper = await mountSuspended(CreateDialog, {
			props: { orgId: ORG, offered },
			attachTo: document.body
		});
		mounted.push(wrapper);
		await wrapper.find('button').trigger('click');
		await vi.waitFor(() => expect(dialog()).not.toBeNull());
		return wrapper;
	}

	it('lists the offered permissions in plain words and nothing else', async () => {
		cleanup = registerApi({});
		await mountDialog();
		const text = dialog()!.textContent ?? '';
		expect(text).toContain('See Organization Details and the Plan');
		expect(text).toContain('See Sites and Their Status');
		expect(text).toContain('See API Keys');
		expect(text).not.toContain('Deploy Code to a Site');
		expect(text).not.toMatch(/\b(org|site|key)\.(read|deploy)\b/);
	});

	it('refuses an empty name and an empty permission list before sending anything', async () => {
		cleanup = registerApi({});
		await mountDialog();
		inDialog('Create Key')!.click();
		await vi.waitFor(() =>
			expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain('name')
		);
		await typeInto('#key-name', 'ci runner');
		inDialog('Create Key')!.click();
		await vi.waitFor(() =>
			expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
				'at least one permission'
			)
		);
		expect(calls).toHaveLength(0);
	});

	it('creates the key, shows the token once with the command, and forgets it on close', async () => {
		cleanup = registerApi({
			[createPath]: { status: 201, body: { ...key(), token: TOKEN } }
		});
		const wrapper = await mountDialog();
		await typeInto('#key-name', ' ci runner ');
		await tick(labelled('See Organization Details and the Plan'));
		inDialog('Create Key')!.click();
		await vi.waitFor(() => expect(dialog()?.textContent).toContain(TOKEN));
		expect(calls[0]?.body).toEqual({ name: 'ci runner', scopes: ['org.read'], expiry: '90d' });
		expect(dialog()?.textContent).toContain('will not be shown again');
		expect(dialog()!.querySelector('[data-command]')!.textContent).toBe(claudeMcpAddCommand());
		expect(dialog()!.querySelector('[data-command]')!.textContent).not.toContain('dfk_');

		inDialog('Copy Key')!.click();
		await vi.waitFor(() => expect(written).toEqual([TOKEN]));
		await vi.waitFor(() => expect(dialog()?.textContent).toContain('Key copied'));

		await tick(labelled('Offer read tools only'));
		await tick(labelled('Ask before any change'));
		expect(dialog()!.querySelector('[data-command]')!.textContent).toBe(
			claudeMcpAddCommand({ methods: ['get'], confirm: 'write' })
		);
		inDialog('Copy Command')!.click();
		await vi.waitFor(() => expect(written).toHaveLength(2));
		expect(written[1]).not.toContain(TOKEN);

		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await vi.waitFor(() => expect(dialog()).toBeNull());
		expect(wrapper.emitted('closed')).toHaveLength(1);
		expect(document.body.textContent).not.toContain(TOKEN);
		await wrapper.find('button').trigger('click');
		await vi.waitFor(() => expect(dialog()).not.toBeNull());
		expect(dialog()!.querySelector('[data-command]')).toBeNull();
		expect(dialog()!.querySelector<HTMLInputElement>('#key-name')!.value).toBe('');
	});

	it('does not tell the page to reload when nothing was created', async () => {
		cleanup = registerApi({});
		const wrapper = await mountDialog();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await vi.waitFor(() => expect(dialog()).toBeNull());
		expect(wrapper.emitted('closed')).toBeUndefined();
	});

	it('shows the copy failure when the clipboard refuses', async () => {
		vi.stubGlobal('navigator', {
			clipboard: {
				writeText: async () => {
					throw new Error('denied');
				}
			}
		});
		cleanup = registerApi({
			[createPath]: { status: 201, body: { ...key(), token: TOKEN } }
		});
		await mountDialog();
		await typeInto('#key-name', 'ci runner');
		await tick(labelled('See Sites and Their Status'));
		inDialog('Create Key')!.click();
		await vi.waitFor(() => expect(dialog()?.textContent).toContain(TOKEN));
		inDialog('Copy Key')!.click();
		await vi.waitFor(() => expect(dialog()?.textContent).toContain('Copy failed'));
	});

	it('asks for a fresh sign-in first when the session is stale, and sends nothing', async () => {
		signIn(null);
		cleanup = registerApi({});
		await mountDialog();
		await typeInto('#key-name', 'ci runner');
		await tick(labelled('See Sites and Their Status'));
		inDialog('Create Key')!.click();
		await vi.waitFor(() => expect(dialog()?.textContent).toContain('Confirm Your Identity'));
		expect(calls).toHaveLength(0);
	});

	it('asks for a sign-in when the server says the sign-in is too old', async () => {
		cleanup = registerApi({
			[createPath]: envelope(403, 'Fresh authentication is required', { requires: 'step-up' })
		});
		await mountDialog();
		await typeInto('#key-name', 'ci runner');
		await tick(labelled('See Sites and Their Status'));
		inDialog('Create Key')!.click();
		await vi.waitFor(() => expect(dialog()?.textContent).toContain('Confirm Your Identity'));
	});

	it('shows the server refusal and keeps the form', async () => {
		cleanup = registerApi({
			[createPath]: envelope(
				403,
				'You cannot give a key a permission you do not hold yourself'
			)
		});
		await mountDialog();
		await typeInto('#key-name', 'ci runner');
		await tick(labelled('See Sites and Their Status'));
		inDialog('Create Key')!.click();
		await vi.waitFor(() =>
			expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
				'do not hold yourself'
			)
		);
		expect(dialog()!.querySelector('#key-name')).not.toBeNull();
	});
});

describe('key permission checklist', () => {
	it('counts what is picked in each group and reports every change', async () => {
		const wrapper = await mountSuspended(Scopes, {
			props: { offered: ['site.read', 'site.deploy', 'org.read'], modelValue: ['site.read'] },
			attachTo: document.body
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('1 of 2 selected');
		expect(wrapper.text()).toContain('0 of 1 selected');
		const boxes = wrapper.findAll('input[type="checkbox"]');
		await boxes[1]!.setValue(true);
		expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([
			['site.read', 'site.deploy']
		]);
		await boxes[0]!.setValue(false);
		expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([['site.deploy']]);
	});

	it('says so when the role holds nothing a key can carry', async () => {
		const wrapper = await mountSuspended(Scopes, {
			props: { offered: [], modelValue: [] }
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('no permissions a key can hold');
	});
});

describe('revoke a key', () => {
	async function mountRevoke(value: KeyView) {
		useApiKeysStore().lists.set(ORG, {
			items: [value],
			nextCursor: null,
			status: 'ready',
			error: null
		});
		const wrapper = await mountSuspended(Revoke, {
			props: { orgId: ORG, apiKey: value },
			attachTo: document.body
		});
		mounted.push(wrapper);
		await wrapper.find('button').trigger('click');
		await vi.waitFor(() => expect(dialog()).not.toBeNull());
		return wrapper;
	}

	it('asks once with a plain confirm for a key that has not been used lately', async () => {
		const value = key({ lastUsedAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString() });
		cleanup = registerApi({
			[revokePath(value.id)]: {
				body: key({ revokedAt: '2026-11-13T00:00:00.000Z' })
			}
		});
		await mountRevoke(value);
		expect(dialog()!.querySelector('input[type="text"]')).toBeNull();
		expect(dialog()?.textContent).not.toContain('used in the last day');
		inDialog('Revoke Key')!.click();
		await vi.waitFor(() => expect(dialog()).toBeNull());
		expect(calls).toHaveLength(1);
		expect(calls[0]?.body).toEqual({});
		expect(useApiKeysStore().lists.get(ORG)?.items[0]?.revokedAt).toBe(
			'2026-11-13T00:00:00.000Z'
		);
	});

	it('never-used keys take the plain confirm too, and cancel sends nothing', async () => {
		cleanup = registerApi({});
		await mountRevoke(key());
		expect(dialog()!.querySelector('input[type="text"]')).toBeNull();
		inDialog('Cancel')!.click();
		await vi.waitFor(() => expect(dialog()).toBeNull());
		expect(calls).toHaveLength(0);
	});

	it('makes the person type the name when the key was used in the last day', async () => {
		const value = key({ lastUsedAt: new Date(Date.now() - 3600_000).toISOString() });
		cleanup = registerApi({
			[revokePath(value.id)]: { body: key({ revokedAt: '2026-11-13T00:00:00.000Z' }) }
		});
		await mountRevoke(value);
		expect(dialog()?.textContent).toContain('used in the last day');
		expect(inDialog('Revoke Key')?.hasAttribute('disabled')).toBe(true);
		await typeInto('input[type="text"]', 'ci runne');
		expect(inDialog('Revoke Key')?.hasAttribute('disabled')).toBe(true);
		await typeInto('input[type="text"]', 'ci runner');
		expect(inDialog('Revoke Key')?.hasAttribute('disabled')).toBe(false);
		expect(calls).toHaveLength(0);
		inDialog('Revoke Key')!.click();
		await vi.waitFor(() => expect(dialog()).toBeNull());
		expect(calls).toHaveLength(1);
	});

	it('shows a refusal in the dialog and keeps it open', async () => {
		cleanup = registerApi({
			[revokePath('key_1')]: envelope(403, 'You do not have access to this resource')
		});
		await mountRevoke(key());
		inDialog('Revoke Key')!.click();
		await vi.waitFor(() =>
			expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
				'do not have access'
			)
		);
		expect(dialog()).not.toBeNull();
	});
});

import { mockComponent, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import PairDialog from '~/components/node/pair/Dialog.vue';
import Row from '~/components/node/Row.vue';
import type { NodeView } from '~/shared/nodes';
import { useNodesStore } from '~/stores/nodes';
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
const pairPath = `POST /api/v1/orgs/${ORG}/nodes/pair`;
const revokePath = (id: string) => `POST /api/v1/orgs/${ORG}/nodes/${id}/revoke`;
const TOKEN = 'tok_AbCdEfGhIjKlMnOpQrStUv';
const pairing = {
	pairingId: 'pair_1',
	claimToken: TOKEN,
	pairUrl: `https://app.example.test/p#${TOKEN}`,
	expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
};

const node = (over: Partial<NodeView> = {}): NodeView => ({
	id: 'nod_abcdefghij01',
	state: 'active',
	name: 'campus-box',
	os: 'linux',
	arch: 'arm64',
	bastionVersion: '0.1.0',
	workerdVersion: '1.2',
	mode: 'standalone',
	pairedAt: '2026-11-01T10:00:00.000Z',
	lastSeenAt: null,
	revokedAt: null,
	...over
});

const envelope = (status: number, code: string, message: string, details = {}) => ({
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

const soon = () => new Date(Date.now() + 5 * 60 * 1000).toISOString();
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const inDialog = (text: string) =>
	[...(dialog()?.querySelectorAll('button') ?? [])].find(
		(button) => button.textContent?.trim() === text
	);

async function openDialog(wrapper: {
	find: (selector: string) => { trigger: (e: string) => unknown };
}) {
	await wrapper.find('button').trigger('click');
	await vi.waitFor(() => expect(dialog()).not.toBeNull());
}

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useNodesStore().$reset();
	signIn(soon());
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

describe('node row', () => {
	async function mountRow(value: NodeView) {
		const wrapper = await mountSuspended(Row, {
			props: { orgId: ORG, node: value },
			attachTo: document.body
		});
		mounted.push(wrapper);
		return wrapper;
	}

	it('shows the host facts, the state and when the node last reported', async () => {
		const wrapper = await mountRow(node({ lastSeenAt: '2026-11-02T09:30:00.000Z' }));
		const text = wrapper.text();
		expect(text).toContain('campus-box');
		expect(text).toContain('linux arm64');
		expect(text).toContain('Active');
		expect(text).toContain('0.1.0');
		expect(text).toContain('standalone');
		expect(text).not.toContain('Never');
		expect(wrapper.find('button').text()).toBe('Revoke');
	});

	it('says Never for a node that has not reported, and offers no revoke for a revoked node', async () => {
		const fresh = await mountRow(node());
		expect(fresh.text()).toContain('Never');
		const revoked = await mountRow(
			node({ state: 'revoked', revokedAt: '2026-11-03T00:00:00.000Z' })
		);
		expect(revoked.text()).toContain('Revoked');
		expect(revoked.find('button').exists()).toBe(false);
	});
});

describe('revoke a node', () => {
	const value = node();

	async function mountRevoke() {
		useNodesStore().lists.set(ORG, {
			items: [value],
			nextCursor: null,
			status: 'ready',
			error: null
		});
		const wrapper = await mountSuspended(Row, {
			props: { orgId: ORG, node: value },
			attachTo: document.body
		});
		mounted.push(wrapper);
		return wrapper;
	}

	async function type(text: string) {
		const input = dialog()!.querySelector<HTMLInputElement>('input[type="text"]')!;
		input.value = text;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await nextTick();
	}

	it('says what happens and keeps the button off until the name matches', async () => {
		cleanup = registerApi({ [revokePath(value.id)]: { body: node({ state: 'revoked' }) } });
		const wrapper = await mountRevoke();
		await openDialog(wrapper);
		const text = dialog()!.textContent ?? '';
		expect(text).toContain('Cut the link to campus-box.');
		expect(text).toContain('keeps running on its own');
		await type('campus');
		expect(inDialog('Revoke Node')?.hasAttribute('disabled')).toBe(true);
		await type('campus-box');
		expect(inDialog('Revoke Node')?.hasAttribute('disabled')).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it('revokes, closes and updates the list', async () => {
		cleanup = registerApi({
			[revokePath(value.id)]: {
				body: node({ state: 'revoked', revokedAt: '2026-11-03T00:00:00.000Z' })
			}
		});
		const wrapper = await mountRevoke();
		await openDialog(wrapper);
		await type('campus-box');
		inDialog('Revoke Node')!.click();
		await vi.waitFor(() => expect(dialog()).toBeNull());
		expect(calls).toHaveLength(1);
		expect(calls[0]?.body).toEqual({});
		expect(useNodesStore().lists.get(ORG)?.items[0]?.state).toBe('revoked');
	});

	it('shows a refusal in the dialog and keeps it open', async () => {
		cleanup = registerApi({
			[revokePath(value.id)]: envelope(
				403,
				'forbidden',
				'You do not have access to this resource'
			)
		});
		const wrapper = await mountRevoke();
		await openDialog(wrapper);
		await type('campus-box');
		inDialog('Revoke Node')!.click();
		await vi.waitFor(() =>
			expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
				'do not have access'
			)
		);
		expect(dialog()).not.toBeNull();
	});

	it('asks for a fresh sign-in before sending when the session is stale', async () => {
		signIn(null);
		cleanup = registerApi({ [revokePath(value.id)]: { body: node({ state: 'revoked' }) } });
		const wrapper = await mountRevoke();
		await openDialog(wrapper);
		await type('campus-box');
		inDialog('Revoke Node')!.click();
		await vi.waitFor(() => expect(dialog()?.textContent).toContain('Confirm Your Identity'));
		expect(calls).toHaveLength(0);
	});

	it('asks for a fresh sign-in when the server says the step-up has lapsed', async () => {
		cleanup = registerApi({
			[revokePath(value.id)]: envelope(403, 'forbidden', 'Fresh authentication is required', {
				requires: 'step-up'
			})
		});
		const wrapper = await mountRevoke();
		await openDialog(wrapper);
		await type('campus-box');
		inDialog('Revoke Node')!.click();
		await vi.waitFor(() => expect(dialog()?.textContent).toContain('Confirm Your Identity'));
	});

	it('closes on Cancel and puts focus back on Revoke', async () => {
		cleanup = registerApi({});
		const wrapper = await mountRevoke();
		const trigger = wrapper.find('button').element as HTMLButtonElement;
		await openDialog(wrapper);
		inDialog('Cancel')!.click();
		await vi.waitFor(() => expect(dialog()).toBeNull());
		await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
		expect(calls).toHaveLength(0);
	});
});

describe('pair a node', () => {
	async function mountPair() {
		const wrapper = await mountSuspended(PairDialog, {
			props: { orgId: ORG },
			attachTo: document.body
		});
		mounted.push(wrapper);
		return wrapper;
	}

	it('lists what leaves the box and what never does, before it creates anything', async () => {
		cleanup = registerApi({ [pairPath]: { status: 201, body: pairing } });
		const wrapper = await mountPair();
		await openDialog(wrapper);
		const text = dialog()!.textContent ?? '';
		expect(text).toContain('What Leaves Your Box');
		expect(text).toContain('The operating system name.');
		expect(text).toContain('Finding codes with a site name and a count, never content.');
		expect(text).toContain('Never leaves your box: site content, databases, secrets');
		expect(text).not.toContain(TOKEN);
		expect(calls).toHaveLength(0);
	});

	it('shows the exact command once, with the token in the address fragment', async () => {
		cleanup = registerApi({ [pairPath]: { status: 201, body: pairing } });
		const wrapper = await mountPair();
		await openDialog(wrapper);
		inDialog('Create Pairing')!.click();
		await vi.waitFor(() => expect(dialog()?.querySelector('code')).not.toBeNull());
		expect(dialog()!.querySelector('code')!.textContent).toBe(
			`bastion pair https://app.example.test/p#${TOKEN}`
		);
		expect(dialog()!.textContent).toContain('works once');
		expect(dialog()!.textContent).toContain('will not be shown again');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.body).toEqual({});
		expect(calls[0]?.headers['idempotency-key']).toBeUndefined();
	});

	it('copies the command', async () => {
		const writeText = vi.fn(async () => undefined);
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
		cleanup = registerApi({ [pairPath]: { status: 201, body: pairing } });
		const wrapper = await mountPair();
		await openDialog(wrapper);
		inDialog('Create Pairing')!.click();
		await vi.waitFor(() => expect(inDialog('Copy Command')).toBeDefined());
		inDialog('Copy Command')!.click();
		await vi.waitFor(() => expect(dialog()!.textContent).toContain('Copied'));
		expect(writeText).toHaveBeenCalledWith(`bastion pair https://app.example.test/p#${TOKEN}`);
	});

	it('says so when the copy fails', async () => {
		vi.stubGlobal('navigator', {
			...navigator,
			clipboard: {
				writeText: async () => {
					throw new Error('blocked');
				}
			}
		});
		cleanup = registerApi({ [pairPath]: { status: 201, body: pairing } });
		const wrapper = await mountPair();
		await openDialog(wrapper);
		inDialog('Create Pairing')!.click();
		await vi.waitFor(() => expect(inDialog('Copy Command')).toBeDefined());
		inDialog('Copy Command')!.click();
		await vi.waitFor(() => expect(dialog()!.textContent).toContain('Copy Failed'));
	});

	it('drops the token when the dialog closes and tells the page to reload', async () => {
		cleanup = registerApi({ [pairPath]: { status: 201, body: pairing } });
		const wrapper = await mountPair();
		await openDialog(wrapper);
		inDialog('Create Pairing')!.click();
		await vi.waitFor(() => expect(dialog()?.querySelector('code')).not.toBeNull());
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await vi.waitFor(() => expect(dialog()).toBeNull());
		expect(wrapper.emitted('closed')).toHaveLength(1);
		expect(document.body.textContent).not.toContain(TOKEN);
		await wrapper.find('button').trigger('click');
		await vi.waitFor(() => expect(dialog()).not.toBeNull());
		expect(dialog()!.querySelector('code')).toBeNull();
	});

	it('does not tell the page to reload when nothing was created', async () => {
		cleanup = registerApi({});
		const wrapper = await mountPair();
		await openDialog(wrapper);
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await vi.waitFor(() => expect(dialog()).toBeNull());
		expect(wrapper.emitted('closed')).toBeUndefined();
	});

	it('asks for a fresh sign-in first when the session is stale, and sends nothing yet', async () => {
		signIn(null);
		cleanup = registerApi({ [pairPath]: { status: 201, body: pairing } });
		const wrapper = await mountPair();
		await openDialog(wrapper);
		inDialog('Create Pairing')!.click();
		await vi.waitFor(() => expect(dialog()?.textContent).toContain('Confirm Your Identity'));
		expect(calls).toHaveLength(0);
	});

	it('asks for a fresh sign-in when the server says the step-up has lapsed', async () => {
		cleanup = registerApi({
			[pairPath]: envelope(403, 'forbidden', 'Fresh authentication is required', {
				requires: 'step-up'
			})
		});
		const wrapper = await mountPair();
		await openDialog(wrapper);
		inDialog('Create Pairing')!.click();
		await vi.waitFor(() => expect(dialog()?.textContent).toContain('Confirm Your Identity'));
	});

	it('shows a refusal in the dialog', async () => {
		cleanup = registerApi({
			[pairPath]: envelope(501, 'not_built', 'Pairing a node is not available yet')
		});
		const wrapper = await mountPair();
		await openDialog(wrapper);
		inDialog('Create Pairing')!.click();
		await vi.waitFor(() =>
			expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
				'Pairing a node is not available yet'
			)
		);
		expect(dialog()?.querySelector('code')).toBeNull();
	});
});

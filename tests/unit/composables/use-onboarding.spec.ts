import { clearNuxtState } from '#app';
import { afterEach, describe, expect, it } from 'vitest';
import { adminUrlFor, kindFor, nameProblem, useOnboarding } from '~/composables/useOnboarding';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const orgId = 'org_personal';
const sitesPath = `POST /api/v1/orgs/${orgId}/sites`;
const operation = { id: 'op_created', status: 'planned', steps: [], targetIds: ['site_1'] };

let cleanup: () => void = () => undefined;

afterEach(() => {
	cleanup();
	clearBrowserState();
	clearNuxtState('onboarding-draft');
});

describe('onboarding draft', () => {
	it('writes each change to session storage', () => {
		const onboarding = useOnboarding();
		onboarding.go(2);
		onboarding.draft.value.name = 'quiet-oak-harbor';

		expect(JSON.parse(sessionStorage.getItem('drupflare.onboarding') ?? '{}')).toMatchObject({
			step: 2,
			name: 'quiet-oak-harbor'
		});
	});

	// a fresh page load starts from storage; the test app keeps state between calls, so the state is cleared first
	it('starts a fresh page from the saved draft', () => {
		sessionStorage.setItem(
			'drupflare.onboarding',
			JSON.stringify({
				step: 2,
				template: 'nuxtpress',
				name: 'quiet-oak-harbor',
				seed: 'seed-1',
				idempotencyKey: 'key-12345'
			})
		);
		clearNuxtState('onboarding-draft');

		expect(useOnboarding().draft.value).toMatchObject({
			step: 2,
			template: 'nuxtpress',
			name: 'quiet-oak-harbor',
			idempotencyKey: 'key-12345'
		});
	});

	it('never stores an admin password in the draft', () => {
		const onboarding = useOnboarding();
		onboarding.go(3);

		const stored = sessionStorage.getItem('drupflare.onboarding') ?? '';
		expect(stored).not.toMatch(/password/i);
	});

	it('sends one request for a double click and the same Idempotency-Key both times', async () => {
		cleanup = registerApi({ [sitesPath]: { status: 202, body: operation } });
		const onboarding = useOnboarding();
		const { idempotencyKey: key, name } = onboarding.draft.value;

		const [first, second] = await Promise.all([
			onboarding.create(orgId, 'drupal'),
			onboarding.create(orgId, 'drupal')
		]);

		expect(first.id).toBe('op_created');
		expect(second).toBe(first);
		const creates = calls.filter((call) => `${call.method} ${call.path}` === sitesPath);
		expect(creates).toHaveLength(1);
		expect(creates[0]?.headers['idempotency-key']).toBe(key);
		expect(creates[0]?.body).toEqual({ kind: 'drupal', name });
	});

	it('starts a new draft with a new key once the create succeeds', async () => {
		cleanup = registerApi({ [sitesPath]: { status: 202, body: operation } });
		const onboarding = useOnboarding();
		const key = onboarding.draft.value.idempotencyKey;

		await onboarding.create(orgId, 'drupal');

		expect(onboarding.draft.value.idempotencyKey).not.toBe(key);
		expect(onboarding.draft.value.step).toBe(1);
	});
});

describe('name and template rules', () => {
	it('rejects names outside the label rules', () => {
		expect(nameProblem('ab')).not.toBeNull();
		expect(nameProblem('Quiet-Oak')).not.toBeNull();
		expect(nameProblem('quiet--oak')).not.toBeNull();
	});

	it('rejects reserved names and paid-only endings', () => {
		expect(nameProblem('admin')).toBe('This name is reserved.');
		expect(nameProblem('quiet-oak-dev')).toMatch(/paid managed/);
	});

	it('accepts a plain three-word name', () => {
		expect(nameProblem('quiet-oak-harbor')).toBeNull();
	});

	it('maps only the templates the create contract can express', () => {
		expect(kindFor('drupal')).toBe('drupal');
		expect(kindFor('bring-your-own')).toBe('custom');
		expect(kindFor('static-site')).toBeNull();
		expect(kindFor('wordpress')).toBeNull();
	});

	it('links Open Admin only for Drupal sites with a hostname', () => {
		expect(adminUrlFor({ kind: 'drupal', primaryHostname: 'a.drupflare.app' })).toBe(
			'https://a.drupflare.app/user/login'
		);
		expect(adminUrlFor({ kind: 'smoke', primaryHostname: 'a.drupflare.app' })).toBeNull();
		expect(adminUrlFor({ kind: 'drupal', primaryHostname: null })).toBeNull();
	});
});

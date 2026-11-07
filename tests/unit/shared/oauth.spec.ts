import { describe, expect, it } from 'vitest';
import {
	CLOUDFLARE_CONSENT_TEXT,
	CONNECT_ONLY_PROVIDERS,
	OAUTH_CONSENT_TEXT,
	OAUTH_LABELS,
	OAUTH_PROVIDERS,
	consentTextFor,
	providerOfState,
	purposeOfState,
	stateFor
} from '../../../src/shared/oauth';

describe('the provider in the state', () => {
	it.each(OAUTH_PROVIDERS)('round-trips %s', (provider) => {
		expect(providerOfState(stateFor(provider, 'abc123'))).toBe(provider);
		expect(providerOfState(stateFor(provider, 'abc123', 'link'))).toBe(provider);
	});

	it('names no provider for a state that does not start with one', () => {
		for (const state of ['', 'abc', 'facebook.abc', '.abc', 'GITHUB.abc']) {
			expect(providerOfState(state)).toBeNull();
		}
	});
});

describe('the purpose in the state', () => {
	it('reads a plain state as a sign-in and a marked one as a link', () => {
		expect(purposeOfState(stateFor('github', 'abc123'))).toBe('sign-in');
		expect(purposeOfState(stateFor('github', 'abc123', 'link'))).toBe('link');
	});

	it('does not read a link out of a token that happens to say link', () => {
		for (const state of ['github.link', 'github.link.abc.def', '', 'link.github.abc']) {
			expect(purposeOfState(state)).toBe('sign-in');
		}
	});
});

describe('what each provider says before the handoff', () => {
	it('labels every provider', () => {
		for (const provider of OAUTH_PROVIDERS) expect(OAUTH_LABELS[provider]).toBeTruthy();
	});

	it('gives Cloudflare its own text and everyone else the common one', () => {
		expect(consentTextFor('cloudflare')).toBe(CLOUDFLARE_CONSENT_TEXT);
		for (const provider of OAUTH_PROVIDERS.filter((name) => name !== 'cloudflare')) {
			expect(consentTextFor(provider)).toBe(OAUTH_CONSENT_TEXT);
		}
	});

	it('lists Cloudflare as the one provider that only connects', () => {
		expect(CONNECT_ONLY_PROVIDERS).toEqual(['cloudflare']);
	});
});

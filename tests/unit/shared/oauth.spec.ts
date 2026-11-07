import { describe, expect, it } from 'vitest';
import { OAUTH_PROVIDERS, providerOfState, stateFor } from '../../../src/shared/oauth';

describe('the provider in the state', () => {
	it.each(OAUTH_PROVIDERS)('round-trips %s', (provider) => {
		expect(providerOfState(stateFor(provider, 'abc123'))).toBe(provider);
	});

	it('names no provider for a state that does not start with one', () => {
		for (const state of ['', 'abc', 'facebook.abc', '.abc', 'GITHUB.abc']) {
			expect(providerOfState(state)).toBeNull();
		}
	});
});

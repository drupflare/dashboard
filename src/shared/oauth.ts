export const OAUTH_PROVIDERS = ['github', 'gitlab', 'google', 'microsoft'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export const OAUTH_CONSENT_TEXT =
	'Drupflare asks the provider for your name and email address to sign you in. It does not read your repositories or any other data. Connecting repositories is a separate step you take later.';

// the registered redirect address carries no provider, so the state names it
export const stateFor = (provider: OAuthProvider, token: string): string => `${provider}.${token}`;

export function providerOfState(state: string): OAuthProvider | null {
	const head = state.split('.')[0];
	return (OAUTH_PROVIDERS as readonly string[]).includes(head ?? '')
		? (head as OAuthProvider)
		: null;
}

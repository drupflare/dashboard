export const OAUTH_PROVIDERS = ['github', 'gitlab', 'cloudflare', 'google', 'microsoft'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export const OAUTH_LABELS: Record<OAuthProvider, string> = {
	github: 'GitHub',
	gitlab: 'GitLab',
	cloudflare: 'Cloudflare',
	google: 'Google',
	microsoft: 'Microsoft'
};

export const OAUTH_CONSENT_TEXT =
	'Drupflare asks the provider for your name and email address to sign you in. It does not read your repositories or any other data. Connecting repositories is a separate step you take later.';

// Cloudflare does not say whether its email address is verified, so it cannot start an account;
// it signs in an account it was connected to
export const CLOUDFLARE_CONSENT_TEXT =
	'Drupflare asks Cloudflare which Cloudflare account you are and for its email address, to show next to the connection. It reads no zones, Workers or other data.';

export const consentTextFor = (provider: OAuthProvider): string =>
	provider === 'cloudflare' ? CLOUDFLARE_CONSENT_TEXT : OAUTH_CONSENT_TEXT;

// a provider that never shares an email address can only be connected from a signed-in session
export const CONNECT_ONLY_PROVIDERS: readonly OAuthProvider[] = ['cloudflare'];

export type OAuthPurpose = 'sign-in' | 'link';

// the registered redirect address carries no provider, so the state names it, and a link
// started from a signed-in session says so
export const stateFor = (
	provider: OAuthProvider,
	token: string,
	purpose: OAuthPurpose = 'sign-in'
): string => (purpose === 'link' ? `${provider}.link.${token}` : `${provider}.${token}`);

export function providerOfState(state: string): OAuthProvider | null {
	const head = state.split('.')[0];
	return (OAUTH_PROVIDERS as readonly string[]).includes(head ?? '')
		? (head as OAuthProvider)
		: null;
}

export function purposeOfState(state: string): OAuthPurpose {
	const parts = state.split('.');
	return parts.length === 3 && parts[1] === 'link' ? 'link' : 'sign-in';
}

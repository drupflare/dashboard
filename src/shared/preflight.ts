import { z } from 'zod';

export const CMS_NAMES = ['drupal', 'wordpress', 'joomla', 'unknown'] as const;
export const VERDICTS = ['candidate', 'needs upgrade', 'not yet supported', 'cannot tell'] as const;
export const SIGNAL_KINDS = ['header', 'markup', 'file', 'robots', 'redirect', 'status'] as const;

export const preflightSignalSchema = z.object({
	kind: z.enum(SIGNAL_KINDS),
	detail: z.string()
});

export const preflightResultSchema = z.object({
	url: z.string(),
	reachable: z.boolean(),
	cms: z.enum(CMS_NAMES),
	version: z.string().nullable(),
	versionSource: z.string().nullable(),
	hosting: z.string().nullable(),
	signals: z.array(preflightSignalSchema),
	verdict: z.enum(VERDICTS),
	notes: z.array(z.string())
});

export const preflightBodySchema = z.strictObject({ url: z.string().trim().min(1).max(2048) });

export type Cms = (typeof CMS_NAMES)[number];
export type Verdict = (typeof VERDICTS)[number];
export type SignalKind = (typeof SIGNAL_KINDS)[number];
export type PreflightSignal = z.infer<typeof preflightSignalSchema>;
export type PreflightResult = z.infer<typeof preflightResultSchema>;

// a refusal is about the address that was entered; a failure is about reaching it
export const PREFLIGHT_REFUSALS = {
	invalid_url: 'That does not look like a web address. Enter an address such as example.edu.',
	protocol: 'The check reads only http and https addresses.',
	port: 'The check reads only the standard web ports, 80 and 443.',
	ip_literal: 'Enter a site name instead of a numeric address.',
	non_public_address:
		'That address points to a private network, so the check will not contact it.'
} as const;

export const PREFLIGHT_FAILURES = {
	unresolvable: 'We could not find that address. Check the spelling and try again.',
	timeout: 'The site did not answer in time.',
	too_large: 'The page is larger than the check reads, so it stopped.',
	redirect_limit: 'The address redirects too many times to follow.',
	redirect_refused: 'The site sent the check to an address it will not read.'
} as const;

export type PreflightRefusal = keyof typeof PREFLIGHT_REFUSALS;
export type PreflightFailure = keyof typeof PREFLIGHT_FAILURES;

export const SURVEY_ONLY_NOTE =
	'This check reads only what the site shows to any visitor. It cannot see a Drupal version the site hides, the modules, the database, the files on disk, or whether your server accepts a connection. Only a read-only survey of the server can tell.';

export const VERDICT_LABELS: Record<Verdict, string> = {
	candidate: 'Worth a Server Survey',
	'needs upgrade': 'Needs an Upgrade First',
	'not yet supported': 'Not Yet Supported',
	'cannot tell': 'Cannot Tell From Outside'
};

export const CMS_LABELS: Record<Cms, string> = {
	drupal: 'Drupal',
	wordpress: 'WordPress',
	joomla: 'Joomla',
	unknown: 'Not Disclosed'
};

export const SIGNAL_LABELS: Record<SignalKind, string> = {
	header: 'Response Header',
	markup: 'Page Markup',
	file: 'Version File',
	robots: 'Robots File',
	redirect: 'Redirect',
	status: 'Status'
};

// a bare name such as example.edu is read as https
export function normalizeAddress(input: string): string {
	const text = input.trim();
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
}

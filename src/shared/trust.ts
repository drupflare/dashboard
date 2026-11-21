import { z } from 'zod';

// every entry names the integration files that make the call, and a spec fails if one is missing
export interface Subprocessor {
	name: string;
	purpose: string;
	dataTouched: string;
	integrations: readonly string[];
}

export const SUBPROCESSORS: readonly Subprocessor[] = [
	{
		name: 'Cloudflare',
		purpose:
			'Runs the dashboard and sites, stores their data (D1, KV, R2, Durable Objects), sends sign-in and notice mail, checks sign-in challenges and looks up DNS names.',
		dataTouched:
			'Account and organisation records, site configuration and content, mail addresses, billing usage reads for managed accounts.',
		integrations: [
			'src/server/integrations/cloudflare-billing.ts',
			'src/server/integrations/cloudflare-connect.ts',
			'src/server/integrations/dns-resolver.ts',
			'src/server/utils/auth.ts'
		]
	},
	{
		name: 'Stripe',
		purpose: 'Takes payment and manages subscriptions and invoices.',
		dataTouched: 'Billing contact, plan, subscription and invoice records.',
		integrations: ['src/server/integrations/stripe.ts']
	},
	{
		name: 'GitHub',
		purpose: 'Sign-in with GitHub and reading connected repositories.',
		dataTouched:
			'Profile and email address from sign-in, repository contents for connected sites.',
		integrations: [
			'src/server/integrations/oauth.ts',
			'src/server/integrations/git-providers/github.ts'
		]
	},
	{
		name: 'Google',
		purpose: 'Sign-in with Google.',
		dataTouched: 'Profile and email address from sign-in.',
		integrations: ['src/server/integrations/oauth.ts']
	}
];

export const TRUST_DOCUMENT_KINDS = [
	'hecvat',
	'vpat',
	'dpa',
	'mapping',
	'policy',
	'report'
] as const;
export type TrustDocumentKind = (typeof TRUST_DOCUMENT_KINDS)[number];

export const TRUST_DOCUMENT_KIND_LABELS: Record<TrustDocumentKind, string> = {
	hecvat: 'HECVAT',
	vpat: 'VPAT',
	dpa: 'Data Processing Agreement',
	mapping: 'Compliance Mapping',
	policy: 'Policy',
	report: 'Report'
};

// the declared type is checked against this list; the bytes are not sniffed
export const TRUST_CONTENT_TYPES = {
	'application/pdf': 'pdf',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
	'text/markdown': 'md',
	'text/plain': 'txt'
} as const;
export type TrustContentType = keyof typeof TRUST_CONTENT_TYPES;

export const TRUST_MAX_BYTES = 10 * 1024 * 1024;

const SHA256 = /^[0-9a-f]{64}$/;

export const trustDocumentViewSchema = z.object({
	id: z.string(),
	title: z.string(),
	kind: z.enum(TRUST_DOCUMENT_KINDS),
	version: z.string(),
	contentType: z.string(),
	sizeBytes: z.number().int().nonnegative(),
	sha256: z.string().regex(SHA256),
	publishedAt: z.string().nullable(),
	retiredAt: z.string().nullable()
});
export type TrustDocumentView = z.infer<typeof trustDocumentViewSchema>;

export const trustUploadSchema = z.strictObject({
	title: z.string().trim().min(1).max(160),
	kind: z.enum(TRUST_DOCUMENT_KINDS),
	version: z.string().trim().min(1).max(40),
	contentType: z.enum(
		Object.keys(TRUST_CONTENT_TYPES) as [TrustContentType, ...TrustContentType[]]
	),
	// base64 of the file; the size cap is checked on the decoded bytes
	contentBase64: z
		.string()
		.min(1)
		.max(Math.ceil((TRUST_MAX_BYTES * 4) / 3) + 4)
});
export type TrustUpload = z.infer<typeof trustUploadSchema>;

export const DATA_LOCATION_STATEMENT =
	'Cloudflare lets each storage product be set to a jurisdiction, such as the United States. Drupflare has not set a jurisdiction on any product, and no contract term commits to where data is stored. Ask before you rely on a location.';

export const SECURITY_PRACTICES: readonly string[] = [
	'Deleting an organisation, creating an API key, transferring a site and changing the recovery contact need a fresh sign-in (step-up).',
	'The organisation and platform audit logs refuse edits and deletes at the database level.',
	'Each organisation audit log is a hash chain, and its verification step reports a broken link.',
	'Owner tokens and integration credentials are encrypted with envelope keys before they are stored.',
	'API responses that are not public are sent with no-store caching.'
];

export const LIMITATIONS: readonly string[] = [
	'SAML sign-in is not available yet.',
	'Managed sites run Drupal only. WordPress and other content management systems are not supported yet.',
	'The audit chain shows that recorded entries were not edited or removed afterwards. It does not record changes made outside the dashboard, and it does not protect against someone who can write both the log and its head record.',
	'Mail is transactional only. Drupflare sends no promotional or marketing mail.',
	'No SOC 2 report is available yet.'
];

export const ATTACH_STAGES = ['ownership', 'certificate', 'routing', 'verification'] as const;
export type AttachStage = (typeof ATTACH_STAGES)[number];

// the zones Drupflare holds; a customer's own domain is never put under either
export const PLATFORM_ZONES = ['drupflare.app', 'drupflare.com'] as const;

export type HostnameRefusal = 'invalid' | 'wildcard' | 'platform_zone';

export type HostnameCheck =
	{ ok: true; hostname: string } | { ok: false; code: HostnameRefusal; message: string };

export const HOSTNAME_REFUSAL_COPY: Record<HostnameRefusal, string> = {
	invalid: 'Enter a domain name such as www.example.org.',
	wildcard: 'A domain that starts with * cannot be attached. Enter one domain name.',
	platform_zone:
		'Drupflare keeps this domain for its own sites. Your site already has an address there, so enter a domain you own instead.'
};

const LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
const NAME = new RegExp(`^(${LABEL}\\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$`);

export function isPlatformName(hostname: string): boolean {
	return PLATFORM_ZONES.some((zone) => hostname === zone || hostname.endsWith(`.${zone}`));
}

export function checkHostname(input: string): HostnameCheck {
	const hostname = input.trim().toLowerCase().replace(/\.$/, '');
	if (hostname.includes('*')) {
		return { ok: false, code: 'wildcard', message: HOSTNAME_REFUSAL_COPY.wildcard };
	}
	if (hostname.length > 253 || !NAME.test(hostname)) {
		return { ok: false, code: 'invalid', message: HOSTNAME_REFUSAL_COPY.invalid };
	}
	if (isPlatformName(hostname)) {
		return { ok: false, code: 'platform_zone', message: HOSTNAME_REFUSAL_COPY.platform_zone };
	}
	return { ok: true, hostname };
}

export interface StageCopy {
	label: string;
	waiting: string;
	pending: string;
	done: string;
}

export const STAGE_COPY: Record<AttachStage, StageCopy> = {
	ownership: {
		label: 'Ownership Check',
		waiting: 'Drupflare checks that you own the domain.',
		pending:
			'Add the ownership record at your DNS provider. Drupflare looks for it every few minutes.',
		done: 'You own this domain.'
	},
	certificate: {
		label: 'Secure Certificate',
		waiting: 'Drupflare gets a certificate so the domain loads over HTTPS.',
		pending:
			'Add the certificate record at your DNS provider. The certificate is issued once Drupflare sees it.',
		done: 'The certificate is issued.'
	},
	routing: {
		label: 'Routing',
		waiting: 'Drupflare sends visitors of this domain to your site.',
		pending: 'Drupflare is sending this domain to your site.',
		done: 'Visitors of this domain reach your site.'
	},
	verification: {
		label: 'Final Check',
		waiting: 'Drupflare loads your site through the domain.',
		pending:
			'Point the domain at Drupflare with the address record below. Drupflare then loads your site through it.',
		done: 'Your site answers on this domain.'
	}
};

export type DnsPurpose = 'ownership' | 'certificate' | 'traffic';

export interface DnsRecord {
	purpose: DnsPurpose;
	type: 'TXT' | 'CNAME';
	name: string;
	value: string;
}

export const DNS_PURPOSE_COPY: Record<DnsPurpose, string> = {
	ownership: 'Proves you own the domain',
	certificate: 'Lets Drupflare issue the certificate',
	traffic: 'Sends visitors to Drupflare'
};

// the bare domain cannot always hold a CNAME; the owner's provider may call the alternative ALIAS or ANAME
export function dnsRecordHint(record: DnsRecord, hostname: string): string | null {
	if (record.purpose !== 'traffic' || hostname.split('.').length > 2) return null;
	return 'If your provider will not take a CNAME on the bare domain, ask it for an ALIAS or ANAME record with the same target.';
}

// the engine writes a failed step's code; each reads as one plain sentence for the owner
export const DOMAIN_ATTACH_REFUSALS: Record<string, string> = {
	hostname_taken:
		'Another site already holds this domain. Remove it from that site first, or use a different domain.',
	platform_zone: HOSTNAME_REFUSAL_COPY.platform_zone,
	invalid: HOSTNAME_REFUSAL_COPY.invalid,
	wildcard: HOSTNAME_REFUSAL_COPY.wildcard,
	custom_domains_refused:
		'Drupflare could not set this domain up. Check that the name is spelled right, then attach it again.',
	provider_unreachable:
		'Drupflare could not reach its certificate service. Attach the domain again in a few minutes.',
	custom_domains_off:
		'Custom domains are not turned on for this Drupflare account yet, so nothing was attached.',
	ownership_failed:
		'The domain could not be confirmed as yours. Check the ownership record at your DNS provider, then attach again.',
	certificate_failed:
		'The certificate could not be issued. Check the certificate record and any CAA records at your DNS provider, then attach again.',
	wait_timed_out:
		'The records did not appear in time. Add them at your DNS provider, then attach the domain again.',
	site_not_ready: 'The site is not live, so no domain was attached.',
	site_busy:
		'Another change to this site was running, so nothing was attached. Attach again when it finishes.',
	lease_lost: 'Another change took over the site while this ran. Attach again.',
	site_unreachable:
		'The domain is set up, but the site did not answer through it. Check that the address record is in place, then attach again.'
};

const ROUTE_REFUSALS: Record<string, string> = {
	...HOSTNAME_REFUSAL_COPY,
	site_not_live: 'This site is not live, so it cannot take a domain.',
	site_busy:
		'Another change to this site is still running. Wait for it to finish, then try again.',
	idempotency_key_reused:
		'This request clashes with an earlier one. Refresh the page and try again.'
};

// the plain reason for a refused start; the server message is the fallback
export function domainRefusalReason(error: { details: unknown; message: string }): string {
	const reason = (error.details as { reason?: unknown } | null)?.reason;
	return (typeof reason === 'string' && ROUTE_REFUSALS[reason]) || error.message;
}

export function attachFailureReason(code: string | null): string | null {
	return code === null ? null : (DOMAIN_ATTACH_REFUSALS[code] ?? null);
}

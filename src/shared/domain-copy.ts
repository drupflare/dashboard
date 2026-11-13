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
			'Drupflare is asking for the certificate. Add any certificate record shown below; the certificate is issued once Drupflare sees it.',
		done: 'The certificate is issued.'
	},
	routing: {
		label: 'Routing',
		waiting: 'Drupflare sends visitors of this domain to your site.',
		pending:
			'Point the domain at Drupflare with the address record below. Visitors are sent to your site once Drupflare sees the record.',
		done: 'Visitors of this domain reach your site.'
	},
	verification: {
		label: 'Final Check',
		waiting: 'Drupflare loads your site through the domain.',
		pending: 'Drupflare is loading your site through the domain.',
		done: 'Your site answers on this domain.'
	}
};

export type DnsPurpose = 'ownership' | 'certificate' | 'traffic';

export interface DnsRecord {
	purpose: DnsPurpose;
	type: 'TXT' | 'CNAME';
	name: string;
	value: string;
	// plain advice that belongs to this one record
	note?: string;
}

export const DNS_PURPOSE_COPY: Record<DnsPurpose, string> = {
	ownership: 'Proves you own the domain',
	certificate: 'Lets Drupflare set up the secure connection',
	traffic: 'Sends visitors to Drupflare'
};

export const DNS_TYPE_COPY: Record<DnsRecord['type'], string> = {
	TXT: 'text record (TXT)',
	CNAME: 'alias record (CNAME)'
};

export const APEX_ROUTING_NOTE =
	'This is a bare domain, and not every DNS provider lets one hold an alias. Ask yours for an ALIAS, ANAME or flattened CNAME record with the same target. If it offers none, use the www version of your domain instead, which takes a plain CNAME.';

export type RecordStatusName = 'ok' | 'missing' | 'wrong' | 'unknown';

export const RECORD_STATUS_COPY: Record<RecordStatusName, string> = {
	ok: 'Found',
	missing: 'Not found yet',
	wrong: 'Found with a different value',
	unknown: 'Could not check right now'
};

export type HazardName = 'apex_cname' | 'conflicting_records' | 'caa_blocks' | 'second_challenge';

const list = (found: string[]) => found.join(', ');

// one plain sentence per hazard; `found` names what the lookup saw
export function hazardText(code: HazardName, found: string[]): string {
	switch (code) {
		case 'apex_cname':
			return `A bare domain cannot hold an alias record next to its other records, such as mail. Your DNS provider answers with an alias at this name (${list(found)}); ask it for an ALIAS or ANAME record instead, or use the www version.`;
		case 'conflicting_records':
			return `This name already points somewhere else (${list(found)}). Replace that record with the address record below, or visitors keep reaching the old place.`;
		case 'caa_blocks':
			return `Your domain has CAA records that allow only ${list(found)} to issue certificates. Add records for letsencrypt.org, pki.goog and ssl.com, or remove the CAA records, or Drupflare cannot get a certificate.`;
		case 'second_challenge':
			return 'More than one ownership value sits at the ownership record name. Remove the old ones and keep the value shown below.';
	}
}

export const WAITING_COPY =
	'Your domain is verified. Custom domains are not switched on for Drupflare yet, so nothing is attached. Press Try Again later, and the attach picks up from your proof.';

// the engine writes a failed step's code; each reads as one plain sentence for the owner
export const DOMAIN_ATTACH_REFUSALS: Record<string, string> = {
	hostname_taken:
		'Another site already holds this domain. Remove it from that site first, or use a different domain.',
	hostname_unproven:
		'Another site asked for this domain first but has not proven it. Add the ownership record shown on this page, check that it is found, then attach again.',
	hostname_displaced:
		'Another site proved ownership of this name, so the name is no longer reserved for this site and this attach stopped.',
	attach_cancelled: 'You cancelled this attach, so the name is no longer reserved for this site.',
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
	domain_in_use: 'This domain is already set up, so it cannot be cancelled here.',
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

export const DOMAINS_OFF_COPY = 'Custom domains are not turned on for this Drupflare account yet.';

export const WAITING_DNS_TITLE = 'Waiting for Your DNS Record';

export const WAITING_DNS_COPY =
	'Add the ownership record below at your DNS provider. Drupflare keeps looking for it and holds this name for your site until the date shown. Cancel if you typed the wrong name.';

export const ROUTING_LATER_COPY =
	'The address record appears here once custom domains are switched on for Drupflare. Add the ownership record now, and your domain is verified in the meantime.';

export const HELD_COPY = DOMAIN_ATTACH_REFUSALS.hostname_taken as string;

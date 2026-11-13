import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';
import {
	decideClaim,
	type CertificateStatus,
	type ClaimRow,
	type HostnameStatus,
	type Observation
} from '../../../src/server/domain/domain-attach';
import type { DnsRecord } from '../../../src/shared/domain-copy';
import type {
	ClaimProof,
	CustomHostnames,
	CustomHostnameState,
	DomainClaim,
	DomainLedger,
	DomainSite
} from '../ports';
import { PermanentError } from '../step';

// not a PermanentError, so the step retries it
export class ProviderUnreachable extends Error {
	constructor(reason: unknown) {
		super(
			`the certificate service did not answer: ${reason instanceof Error ? reason.message : String(reason)}`
		);
		this.name = 'ProviderUnreachable';
	}
}

const API = 'https://api.cloudflare.com/client/v4';

const hostnameResult = z.looseObject({
	id: z.string().min(1),
	hostname: z.string(),
	status: z.string().optional(),
	ssl: z
		.looseObject({
			status: z.string().optional(),
			validation_records: z
				.array(
					z.looseObject({
						txt_name: z.string().optional(),
						txt_value: z.string().optional()
					})
				)
				.optional()
		})
		.optional(),
	ownership_verification: z
		.looseObject({ name: z.string().optional(), value: z.string().optional() })
		.optional()
});

const envelope = z.looseObject({
	success: z.boolean().optional(),
	errors: z
		.array(z.looseObject({ code: z.number().optional(), message: z.string().optional() }))
		.optional(),
	result: z.unknown().optional()
});

// the provider's own status words, read by name; a word not listed reads as still pending
export function hostnameStatusOf(status: string | undefined): HostnameStatus {
	switch (status) {
		case 'active':
		case 'active_redeploying':
			return 'active';
		case 'moved':
			return 'moved';
		case 'deleted':
		case 'pending_deletion':
			return 'deleted';
		case 'blocked':
		case 'pending_blocked':
			return 'blocked';
		default:
			return 'pending';
	}
}

export function certificateStatusOf(status: string | undefined): CertificateStatus {
	if (status === undefined) return 'none';
	if (status === 'active') return 'active';
	if (status.endsWith('_timed_out') || status === 'expired' || status === 'deleted')
		return 'failed';
	return 'pending';
}

export function observationOf(result: z.infer<typeof hostnameResult>, target: string): Observation {
	const records: DnsRecord[] = [];
	const owner = result.ownership_verification;
	if (owner?.name !== undefined && owner.value !== undefined) {
		records.push({ purpose: 'certificate', type: 'TXT', name: owner.name, value: owner.value });
	}
	for (const record of result.ssl?.validation_records ?? []) {
		if (record.txt_name !== undefined && record.txt_value !== undefined) {
			records.push({
				purpose: 'certificate',
				type: 'TXT',
				name: record.txt_name,
				value: record.txt_value
			});
		}
	}
	records.push({ purpose: 'traffic', type: 'CNAME', name: result.hostname, value: target });
	return {
		hostnameStatus: hostnameStatusOf(result.status),
		certificateStatus: certificateStatusOf(result.ssl?.status),
		records
	};
}

export interface CustomHostnameOptions {
	fetch: typeof fetch;
	token: string;
	// both are set per deploy; unset means the account has no custom hostname zone yet
	zoneId: string | undefined;
	target: string | undefined;
	timeoutMs: number;
}

const OFF = 'custom_domains_off';

// the codes the API answered on 2026-11-13 for an account without the feature: 1404 no quota has
// been allocated, 1456 is the other answer for the same state
const OFF_CODES: readonly number[] = [1404, 1456];

// the account needs Cloudflare for SaaS and a token that can edit SSL and certificates; whether the
// API answers a missing feature with 403 is unverified, so every 401 and 403 reads as either one
export function customHostnamesOf(options: CustomHostnameOptions): CustomHostnames {
	const { zoneId, target } = options;
	const base =
		zoneId === undefined || zoneId === '' ? null : `${API}/zones/${zoneId}/custom_hostnames`;
	const where = target === undefined || target === '' ? null : target;

	async function call(
		method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
		path: string,
		body?: unknown
	): Promise<{ status: number; result: unknown }> {
		if (base === null || where === null) {
			throw new PermanentError(
				OFF,
				'custom domains have no zone or target configured for this deploy'
			);
		}
		let response: Response;
		try {
			response = await options.fetch(`${base}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${options.token}`,
					'content-type': 'application/json'
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(options.timeoutMs)
			});
		} catch (error) {
			throw new ProviderUnreachable(error);
		}
		const status = response.status;
		if (status === 404) {
			await response.body?.cancel();
			return { status, result: null };
		}
		let parsed: z.infer<typeof envelope> | null = null;
		try {
			const checked = envelope.safeParse(await response.json());
			parsed = checked.success ? checked.data : null;
		} catch {
			parsed = null;
		}
		if (parsed?.errors?.some((error) => OFF_CODES.includes(error.code ?? 0))) {
			throw new PermanentError(
				OFF,
				`Cloudflare answered ${status} with code ${parsed.errors.find((error) => OFF_CODES.includes(error.code ?? 0))?.code}: Cloudflare for SaaS is not enabled for the zone`
			);
		}
		if (status === 401 || status === 403) {
			throw new PermanentError(
				OFF,
				`Cloudflare answered ${status}: Cloudflare for SaaS may be off for the account, or the token cannot edit SSL and certificates`
			);
		}
		if (status === 429 || status >= 500) throw new ProviderUnreachable(`status ${status}`);
		if (status >= 400) {
			const first = parsed?.errors?.[0];
			throw new PermanentError(
				'custom_domains_refused',
				`Cloudflare refused the request with ${status}${first?.code === undefined ? '' : ` (code ${first.code})`}`
			);
		}
		return { status, result: parsed?.result ?? null };
	}

	const stateOf = (result: unknown): CustomHostnameState => {
		const parsed = hostnameResult.parse(result);
		return { providerId: parsed.id, observation: observationOf(parsed, where ?? '') };
	};

	const ssl = { method: 'txt', type: 'dv', settings: { min_tls_version: '1.2' } };

	return {
		async ensure(hostname) {
			const found = await call('GET', `?hostname=${encodeURIComponent(hostname)}`);
			const listed = Array.isArray(found.result) ? found.result : [];
			const existing = listed.find(
				(item) => (item as { hostname?: string }).hostname === hostname
			);
			if (existing !== undefined) return stateOf(existing);
			const created = await call('POST', '', { hostname, ssl });
			return stateOf(created.result);
		},
		async read(providerId) {
			const answer = await call('GET', `/${encodeURIComponent(providerId)}`);
			return answer.result === null ? null : stateOf(answer.result);
		},
		async refresh(providerId) {
			const answer = await call('PATCH', `/${encodeURIComponent(providerId)}`, { ssl });
			if (answer.result === null) {
				throw new PermanentError(
					'ownership_failed',
					'the provider no longer holds this hostname'
				);
			}
			return stateOf(answer.result);
		},
		async remove(providerId) {
			const answer = await call('DELETE', `/${encodeURIComponent(providerId)}`);
			return answer.status === 404 ? 'absent' : 'deleted';
		}
	};
}

interface DomainDbRow {
	hostname: string;
	organization_id: string;
	site_id: string;
	operation_id: string;
	epoch: number;
	state: ClaimRow['state'];
	provider_id: string | null;
	ownership_epoch: number | null;
	updated_at: number;
}

const COLUMNS =
	'hostname, organization_id, site_id, operation_id, epoch, state, provider_id, ownership_epoch';
const READ_COLUMNS = `${COLUMNS}, updated_at`;

function toClaim(row: DomainDbRow): ClaimRow {
	return {
		hostname: row.hostname,
		organizationId: row.organization_id,
		siteId: row.site_id,
		operationId: row.operation_id,
		epoch: row.epoch,
		state: row.state,
		providerId: row.provider_id,
		ownershipEpoch: row.ownership_epoch,
		updatedAt: row.updated_at
	};
}

export class D1DomainLedger implements DomainLedger {
	constructor(
		private readonly db: D1Database,
		private readonly now: () => number = Date.now
	) {}

	async site(siteId: string): Promise<DomainSite | null> {
		const row = await this.db
			.prepare('SELECT organization_id, account_id, plane, state FROM sites WHERE id = ?')
			.bind(siteId)
			.first<{
				organization_id: string;
				account_id: string | null;
				plane: DomainSite['plane'];
				state: DomainSite['state'];
			}>();
		if (row === null) return null;
		return {
			organizationId: row.organization_id,
			accountId: row.account_id,
			plane: row.plane,
			state: row.state
		};
	}

	async current(hostname: string): Promise<ClaimRow | null> {
		const row = await this.db
			.prepare(`SELECT ${READ_COLUMNS} FROM custom_domains WHERE hostname = ?`)
			.bind(hostname)
			.first<DomainDbRow>();
		return row === null ? null : toClaim(row);
	}

	// every write is guarded by the epoch it read, so two claims racing for one hostname cannot both win
	async claim(
		hostname: string,
		who: { organizationId: string; siteId: string; operationId: string },
		now: number,
		proof?: ClaimProof
	): Promise<DomainClaim> {
		const row = await this.current(hostname);
		const holder = row === null ? null : await this.site(row.siteId);
		const live = holder !== null && (holder.state === 'active' || holder.state === 'suspended');
		const decision = decideClaim(
			row,
			who,
			live,
			proof === undefined ? {} : { now, contest: true }
		);
		if (decision.kind === 'refuse') return { ok: false };
		let proven = false;
		if (decision.kind === 'contest') {
			// the check runs before the write, and the write fails if the holder proved in between
			if (proof === undefined || !(await proof(decision.epoch))) {
				return { ok: false, unproven: true };
			}
			proven = true;
		}
		const guarded = decision.kind === 'contest' || decision.kind === 'expired';
		if (decision.kind === 'insert') {
			const { meta } = await this.db
				.prepare(
					`INSERT INTO custom_domains (${COLUMNS}, created_at, updated_at)
					VALUES (?, ?, ?, ?, 1, 'claimed', NULL, NULL, ?, ?) ON CONFLICT (hostname) DO NOTHING`
				)
				.bind(hostname, who.organizationId, who.siteId, who.operationId, now, now)
				.run();
			return meta.changes === 1
				? { ok: true, epoch: 1, providerId: null, previous: null }
				: { ok: false };
		}
		if (decision.kind === 'keep') {
			const held = row as ClaimRow;
			if (held.state === 'claimed' && held.operationId !== who.operationId) {
				const { meta } = await this.db
					.prepare(
						'UPDATE custom_domains SET operation_id = ?, updated_at = ? WHERE hostname = ? AND epoch = ?'
					)
					.bind(who.operationId, now, hostname, held.epoch)
					.run();
				if (meta.changes !== 1) return { ok: false };
			}
			return { ok: true, epoch: held.epoch, providerId: held.providerId, previous: null };
		}
		const { meta } = await this.db
			.prepare(
				`UPDATE custom_domains SET organization_id = ?, site_id = ?, operation_id = ?,
				epoch = epoch + 1, state = 'claimed', provider_id = NULL,
					ownership_epoch = ${proven ? 'epoch + 1' : 'NULL'}, updated_at = ?
				WHERE hostname = ? AND epoch = ?${guarded ? " AND state = 'claimed' AND ownership_epoch IS NOT epoch" : ''}`
			)
			.bind(
				who.organizationId,
				who.siteId,
				who.operationId,
				now,
				hostname,
				decision.previous.epoch
			)
			.run();
		if (meta.changes === 1) {
			return {
				ok: true,
				epoch: decision.epoch,
				providerId: null,
				previous: decision.previous
			};
		}
		return { ok: false };
	}

	async setProvider(hostname: string, epoch: number, providerId: string): Promise<boolean> {
		const { meta } = await this.db
			.prepare(
				`UPDATE custom_domains SET provider_id = ? WHERE hostname = ? AND epoch = ?
				AND state <> 'released'`
			)
			.bind(providerId, hostname, epoch)
			.run();
		return meta.changes === 1;
	}

	async markRouted(hostname: string, epoch: number, siteId: string): Promise<boolean> {
		const { meta } = await this.db
			.prepare(
				`UPDATE custom_domains SET state = 'routed', updated_at = ? WHERE hostname = ?
				AND epoch = ? AND site_id = ? AND state <> 'released'`
			)
			.bind(this.now(), hostname, epoch, siteId)
			.run();
		return meta.changes === 1;
	}

	async proveOwnership(hostname: string, epoch: number, siteId: string): Promise<boolean> {
		const { meta } = await this.db
			.prepare(
				`UPDATE custom_domains SET ownership_epoch = ?, updated_at = ? WHERE hostname = ?
				AND epoch = ? AND site_id = ? AND state <> 'released'`
			)
			.bind(epoch, this.now(), hostname, epoch, siteId)
			.run();
		return meta.changes === 1;
	}

	async heldBy(siteId: string): Promise<ClaimRow[]> {
		const { results } = await this.db
			.prepare(
				`SELECT ${READ_COLUMNS} FROM custom_domains WHERE site_id = ? AND state <> 'released'
				ORDER BY hostname`
			)
			.bind(siteId)
			.all<DomainDbRow>();
		return results.map(toClaim);
	}

	async release(hostname: string, epoch: number, siteId: string): Promise<boolean> {
		const { meta } = await this.db
			.prepare(
				`UPDATE custom_domains SET state = 'released', provider_id = NULL,
					ownership_epoch = NULL, updated_at = ?
				WHERE hostname = ? AND epoch = ? AND site_id = ? AND state <> 'released'`
			)
			.bind(this.now(), hostname, epoch, siteId)
			.run();
		return meta.changes === 1;
	}
}

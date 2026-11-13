import { newId } from '@contracts/common';
import {
	ROW_CLASSES,
	ROW_STATES,
	type EstateReport,
	type RowClass,
	type RowState,
	type RowVerdict
} from '@contracts/estate';
import { computePlanDigest, DEFAULT_CHANGE_BUDGET } from '@contracts/operations';
import {
	planEstateAssess,
	type EstateAssessInput
} from '../../../engine/src/workflows/estate-assess';
import type { ChallengeKeys } from '../../shared/custody/challenge';
import {
	deriveEstateProof,
	ESTATE_PROOF_LABEL,
	ESTATE_PROOF_PATH
} from '../../shared/custody/estate-proof';
import { credentialRefusal } from '../../shared/custody/import-credentials';
import { ApiError } from '../../shared/errors';
import type { AssessmentRecord, EstateRowRecord } from '../../shared/estate-sql';
import { ESTATE_BLOB_BYTES } from '../../shared/estate-sql';
import type {
	AssessmentView,
	CheckView,
	ProofCheck,
	ProofView,
	RowView
} from '../../shared/estate-view';
import { nowUtc } from '../../shared/utils/time';
import {
	cancelAssessment,
	countRows,
	getAssessment,
	getAssessmentByKey,
	insertAssessment,
	listAssessments,
	pageRows,
	provenDomains,
	recordProof,
	type NewAssessmentRow,
	type RowFilter
} from '../db/repos/assessments';
import { createOperationRecord } from '../db/repos/backups';
import { getImportCredential } from '../db/repos/import-credentials';
import { textOf, type DnsResolver } from '../domain/dns-check';
import {
	classifySite,
	parseInventory,
	proofAllowance,
	reconcile,
	toCsv,
	type EstateSite
} from '../domain/estate';
import { registrableDomain } from '../domain/preflight';
import { dohResolve, guardedFetch } from '../integrations/url-guard';
import type { AuditInput } from './audit';
import { backupServices } from './backups';
import { importServices } from './site-import';
import { startRecorded, type SiteServices } from './sites';

export interface EstateServices {
	keys: () => Promise<ChallengeKeys>;
	dns: DnsResolver;
	// the first bytes of a file at the address, or null when nothing public answered
	readFile: (url: string) => Promise<{ status: number; text: string } | null>;
	audit: (orgId: string, input: AuditInput) => Promise<unknown>;
	now: () => number;
}

const notBuilt = (what: string) => async (): Promise<never> => {
	throw new ApiError('not_built', `${what} is not available yet`);
};

async function readPublicFile(url: string) {
	try {
		const response = await guardedFetch(
			url,
			{ fetch: (input, init) => fetch(input, init), resolve: (name) => dohResolve(name) },
			{ maxRedirects: 2, maxBytes: 2048, timeoutMs: 5000, truncate: true }
		);
		return { status: response.status, text: new TextDecoder().decode(response.body) };
	} catch {
		return null;
	}
}

function productionServices(): EstateServices {
	return {
		keys: notBuilt('Domain checks'),
		dns: { query: notBuilt('Domain checks') },
		readFile: readPublicFile,
		audit: (orgId, input) => importServices().audit(orgId, input),
		now: Date.now
	};
}

let installed = productionServices();

export function setEstateServices(over: Partial<EstateServices>): void {
	installed = { ...installed, ...over };
}

export function resetEstateServices(): void {
	installed = productionServices();
}

export function estateServices(): EstateServices {
	return installed;
}

const iso = (ms: number) => new Date(ms).toISOString();

// #region check

export async function checkInventory(text: string): Promise<CheckView> {
	const parsed = parseInventory(text);
	const sites = await reconcile(parsed.rows);
	return {
		fileError: parsed.fileError,
		rows: parsed.rows.length,
		sites: sites.length,
		notReconciled: sites.filter((site) => !site.reconciled).length,
		rejected: parsed.rejected,
		rejectedTotal: parsed.rejectedTotal,
		ignoredColumns: parsed.ignoredColumns
	};
}

// #endregion

// #region views

const zero = <K extends string>(keys: readonly K[]) =>
	Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;

async function viewOf(
	services: SiteServices,
	orgId: string,
	record: AssessmentRecord
): Promise<AssessmentView> {
	const counts = await countRows(await services.getDb(), orgId, record.id);
	const progress = zero<RowState>(ROW_STATES);
	const classes = zero<RowClass>(ROW_CLASSES);
	for (const row of counts) {
		progress[row.state as RowState] += row.n;
		if (row.class !== null) classes[row.class as RowClass] += row.n;
	}
	return {
		id: record.id,
		operationId: record.operationId,
		state: record.state as AssessmentView['state'],
		rowCount: record.rowCount,
		rejectedTotal: record.rejectedTotal,
		progress,
		classes,
		report: record.report === null ? null : (JSON.parse(record.report) as EstateReport),
		createdAt: iso(record.createdAt),
		updatedAt: iso(record.updatedAt)
	};
}

function rowViewOf(record: EstateRowRecord): RowView {
	const site = JSON.parse(record.site) as EstateSite;
	const verdict = record.verdict === null ? null : (JSON.parse(record.verdict) as RowVerdict);
	return {
		number: record.number,
		hostname: record.hostname,
		aliases: site.input.aliases,
		server: site.input.server,
		cms: site.input.cms,
		version: site.input.version,
		class: verdict?.class ?? null,
		state: record.state as RowState,
		basis: verdict?.basis ?? site.basis,
		reconciled: verdict?.reconciled ?? site.reconciled,
		missing: verdict?.missing ?? null,
		findings: verdict?.findings ?? site.findings
	};
}

export async function readAssessment(
	services: SiteServices,
	orgId: string,
	id: string
): Promise<AssessmentView> {
	const record = await getAssessment(await services.getDb(), orgId, id);
	if (record === null) throw new ApiError('not_found', 'Not found');
	return viewOf(services, orgId, record);
}

export async function listAssessmentViews(
	services: SiteServices,
	orgId: string,
	options: { before?: { createdAt: number; id: string }; count: number }
): Promise<{ items: AssessmentView[]; records: AssessmentRecord[] }> {
	const records = await listAssessments(await services.getDb(), orgId, options);
	const items = await Promise.all(records.map((record) => viewOf(services, orgId, record)));
	return { items, records };
}

export async function readRows(
	services: SiteServices,
	orgId: string,
	id: string,
	options: { after: number; count: number; filter?: RowFilter }
): Promise<RowView[]> {
	const db = await services.getDb();
	if ((await getAssessment(db, orgId, id)) === null) throw new ApiError('not_found', 'Not found');
	return (await pageRows(db, orgId, id, options)).map(rowViewOf);
}

// #endregion

// #region start

export interface StartEstateInput {
	orgId: string;
	userId: string;
	actor: string;
	text: string;
	credentialIds: string[];
	idempotencyKey: string;
}

async function accessOf(
	services: SiteServices,
	input: StartEstateInput
): Promise<{ server: string; credentialId: string }[]> {
	const db = await services.getDb();
	const now = estateServices().now();
	const out: { server: string; credentialId: string }[] = [];
	for (const credentialId of new Set(input.credentialIds)) {
		const row = await getImportCredential(db, input.orgId, credentialId);
		if (row === null) throw new ApiError('not_found', 'Not found');
		const problem = credentialRefusal(row, now);
		if (problem === 'expired') {
			throw new ApiError(
				'unprocessable',
				'The key for this server expired. Make a new one.',
				{
					reason: 'credential_expired'
				}
			);
		}
		if (problem === 'host_key_unconfirmed') {
			throw new ApiError('unprocessable', 'Confirm the host key of the server first.', {
				reason: 'host_key_unconfirmed'
			});
		}
		out.push({ server: row.host, credentialId });
	}
	return out;
}

// the id of an assessment follows the id of its operation, so a repeat of a half-finished start
// finds the same assessment
const assessmentIdOf = (operationId: string) => `asm_${operationId.slice(3)}`;

export async function startAssessment(
	services: SiteServices,
	input: StartEstateInput
): Promise<AssessmentView> {
	const db = await services.getDb();
	const known = await getAssessmentByKey(db, input.orgId, input.idempotencyKey);
	if (known) return viewOf(services, input.orgId, known);

	const parsed = parseInventory(input.text);
	if (parsed.fileError !== null) {
		throw new ApiError('unprocessable', parsed.fileError, { reason: 'inventory_unreadable' });
	}
	if (parsed.rows.length === 0) {
		throw new ApiError('unprocessable', 'No row in the file could be used.', {
			reason: 'inventory_empty',
			rejected: parsed.rejected
		});
	}
	const access = await accessOf(services, input);
	const accessText = JSON.stringify(access);
	if (accessText.length > ESTATE_BLOB_BYTES.access) {
		throw new ApiError('unprocessable', 'Too many servers were added.', {
			reason: 'too_many_servers'
		});
	}
	const sites = await reconcile(parsed.rows);
	const allowance = proofAllowance(sites, await provenDomains(db, input.orgId));
	const rows: NewAssessmentRow[] = sites.map((site) => {
		const needsProof = allowance.get(site.number) ?? null;
		const siteText = JSON.stringify(site);
		if (needsProof === null) {
			return {
				number: site.number,
				hostname: site.input.hostname,
				state: 'pending',
				class: null,
				site: siteText,
				verdict: null,
				needsProof: null
			};
		}
		const verdict = classifySite(site, {
			preflight: null,
			dossier: null,
			access: 'none',
			needsProof
		});
		return {
			number: site.number,
			hostname: site.input.hostname,
			state: 'needs proof',
			class: verdict.class,
			site: siteText,
			verdict: JSON.stringify(verdict),
			needsProof
		};
	});
	if (rows.some((row) => row.site.length > ESTATE_BLOB_BYTES.site)) {
		throw new ApiError('unprocessable', 'A row in the file is longer than a row can be.', {
			reason: 'row_too_large'
		});
	}

	const operationId = newId('op');
	const assessmentId = assessmentIdOf(operationId);
	const params: EstateAssessInput = {
		operationId,
		orgId: input.orgId,
		assessmentId,
		ceilingBytes: backupServices().restoreCeilingBytes
	};
	const plan = planEstateAssess(params);
	const now = nowUtc().toMillis();
	const { operation, created } = await createOperationRecord(db, {
		id: operationId,
		organizationId: input.orgId,
		accountId: null,
		siteId: null,
		type: 'estate.assess',
		status: 'planned',
		idempotencyKey: input.idempotencyKey,
		targetIds: plan.targetIds,
		preconditions: plan.preconditions,
		planDigest: await computePlanDigest(plan),
		blastRadius: plan.blastRadius,
		rollbackPoint: plan.rollbackPoint,
		verification: 'not-required',
		budget: DEFAULT_CHANGE_BUDGET,
		steps: plan.steps,
		inputs: params,
		now
	});
	// a repeat after a crash finds the operation of the first try and goes on with its ids
	const ids = {
		operationId: operation.operation.id,
		assessmentId: assessmentIdOf(operation.operation.id)
	};
	if (!created) {
		const again = await getAssessmentByKey(db, input.orgId, input.idempotencyKey);
		if (again) return viewOf(services, input.orgId, again);
	}
	await insertAssessment(
		db,
		{
			organizationId: input.orgId,
			id: ids.assessmentId,
			operationId: ids.operationId,
			idempotencyKey: input.idempotencyKey,
			rowCount: rows.length,
			rejectedTotal: parsed.rejectedTotal,
			access: accessText,
			createdBy: input.userId,
			now
		},
		rows
	);
	await estateServices().audit(input.orgId, {
		actor: input.actor,
		action: 'assessment.manage',
		target: ids.assessmentId,
		detail: { operationId: ids.operationId, sites: rows.length, servers: access.length }
	});
	if (created) {
		await startRecorded(
			services,
			db,
			input.orgId,
			operation,
			{
				workflow: 'estate-assess',
				id: operationId,
				params: params as unknown as Record<string, unknown>
			},
			'The assessment could not be started'
		);
	}
	return readAssessment(services, input.orgId, ids.assessmentId);
}

// #endregion

// #region cancel and export

export async function cancelEstate(
	services: SiteServices,
	input: { orgId: string; id: string; actor: string }
): Promise<AssessmentView> {
	const db = await services.getDb();
	const record = await getAssessment(db, input.orgId, input.id);
	if (record === null) throw new ApiError('not_found', 'Not found');
	if (record.state === 'cancelled') return viewOf(services, input.orgId, record);
	const changed = await cancelAssessment(db, input.orgId, input.id, nowUtc().toMillis());
	if (!changed) {
		throw new ApiError('conflict', 'This assessment has already finished.', {
			reason: 'assessment_finished'
		});
	}
	await estateServices().audit(input.orgId, {
		actor: input.actor,
		action: 'assessment.manage',
		target: input.id,
		detail: { cancelled: true }
	});
	return readAssessment(services, input.orgId, input.id);
}

const EXPORT_PAGE = 100;

export async function exportCsv(
	services: SiteServices,
	input: { orgId: string; id: string }
): Promise<string> {
	const db = await services.getDb();
	if ((await getAssessment(db, input.orgId, input.id)) === null) {
		throw new ApiError('not_found', 'Not found');
	}
	const rows: { site: EstateSite; verdict: RowVerdict }[] = [];
	let after = 0;
	for (;;) {
		const page = await pageRows(db, input.orgId, input.id, { after, count: EXPORT_PAGE });
		for (const record of page) {
			const site = JSON.parse(record.site) as EstateSite;
			const verdict: RowVerdict =
				record.verdict === null
					? {
							class: 'information',
							state: record.state as RowState,
							basis: site.basis,
							reconciled: site.reconciled,
							missing: null,
							findings: site.findings
						}
					: (JSON.parse(record.verdict) as RowVerdict);
			rows.push({ site, verdict });
		}
		if (page.length < EXPORT_PAGE) break;
		after = page[page.length - 1]!.number;
	}
	return toCsv(rows);
}

// #endregion

// #region ownership proof

function proofDomain(input: string): string {
	const host = input.trim().toLowerCase().replace(/\.$/, '');
	if (!/^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
		throw new ApiError('unprocessable', 'Enter a domain such as example.edu.', {
			reason: 'invalid_domain'
		});
	}
	return registrableDomain(host);
}

export async function startProof(
	services: SiteServices,
	input: { orgId: string; domain: string }
): Promise<ProofView> {
	const domain = proofDomain(input.domain);
	const proof = await deriveEstateProof(await estateServices().keys(), {
		orgId: input.orgId,
		domain
	});
	const proven = (await provenDomains(await services.getDb(), input.orgId)).has(domain);
	return {
		domain,
		proven,
		record: { type: 'TXT', name: `${ESTATE_PROOF_LABEL}.${domain}`, value: proof.value },
		file: { path: ESTATE_PROOF_PATH, content: proof.value }
	};
}

export async function checkProof(
	services: SiteServices,
	input: { orgId: string; actor: string; domain: string; method: 'dns' | 'http' }
): Promise<ProofCheck> {
	const domain = proofDomain(input.domain);
	const proof = await deriveEstateProof(await estateServices().keys(), {
		orgId: input.orgId,
		domain
	});
	let found = false;
	let detail = '';
	if (input.method === 'dns') {
		const reply = await estateServices().dns.query(`${ESTATE_PROOF_LABEL}.${domain}`, 'TXT');
		if (!reply.ok) detail = 'The name servers did not answer. Try again in a few minutes.';
		else {
			found = reply.records.some((record) => proof.accepted.includes(textOf(record.data)));
			detail = found ? 'The record is in place.' : 'The record was not found yet.';
		}
	} else {
		const file = await estateServices().readFile(`https://${domain}${ESTATE_PROOF_PATH}`);
		if (file === null) detail = 'The file could not be read from the site.';
		else {
			found = file.status === 200 && proof.accepted.includes(file.text.trim());
			detail = found ? 'The file is in place.' : 'The file did not hold the expected text.';
		}
	}
	if (found) {
		await recordProof(
			await services.getDb(),
			input.orgId,
			domain,
			input.method,
			nowUtc().toMillis()
		);
		await estateServices().audit(input.orgId, {
			actor: input.actor,
			action: 'assessment.manage',
			target: domain,
			detail: { proof: input.method }
		});
	}
	return { domain, proven: found, method: input.method, detail };
}

// #endregion

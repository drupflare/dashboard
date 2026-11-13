import { sha256Hex } from '@contracts/common';
import {
	CMS_VALUES,
	ESTATE_LIMITS,
	INVENTORY_COLUMNS,
	REPORT_COLUMNS,
	ROW_CLASSES,
	ROW_STATES,
	type EstateFinding,
	type EstateReport,
	type InventoryRow,
	type RowClass,
	type RowState,
	type RowVerdict,
	type SourceSiteId
} from '@contracts/estate';
import type { PreflightResult } from '../../shared/preflight';
import { DRUPAL_MAJOR, type Dossier } from './dossier';
import { registrableDomain } from './preflight';

// #region parse

export interface Rejected {
	line: number;
	reason: string;
}

export interface ParsedInventory {
	rows: { line: number; row: InventoryRow }[];
	rejected: Rejected[];
	rejectedTotal: number;
	ignoredColumns: string[];
	// set when the whole file was refused; rows is empty then
	fileError: string | null;
}

const HOSTNAME =
	/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

const COLUMN_KEYS: Record<(typeof INVENTORY_COLUMNS)[number], keyof InventoryRow> = {
	hostname: 'hostname',
	aliases: 'aliases',
	server: 'server',
	docroot: 'docroot',
	site_dir: 'siteDir',
	database_host: 'databaseHost',
	database_name: 'databaseName',
	table_prefix: 'tablePrefix',
	site_uuid: 'siteUuid',
	cms: 'cms',
	version: 'version',
	owner_note: 'ownerNote'
};

const KNOWN_COLUMNS = new Set<string>([...INVENTORY_COLUMNS, ...REPORT_COLUMNS]);

export const emptyRow = (hostname: string): InventoryRow => ({
	hostname,
	aliases: [],
	server: '',
	docroot: '',
	siteDir: '',
	databaseHost: '',
	databaseName: '',
	tablePrefix: '',
	siteUuid: '',
	cms: 'unknown',
	version: '',
	ownerNote: ''
});

function columnName(header: string): string {
	return header
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, '_');
}

// a leading apostrophe that the export put before a spreadsheet formula character comes off again
const unguard = (value: string) => (/^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value);

const bare = (host: string) => host.trim().toLowerCase().replace(/\.$/, '');

function hostProblem(host: string): string | null {
	if (host === '') return 'missing hostname';
	if (host.length > ESTATE_LIMITS.hostnameChars) return 'hostname is longer than 253 characters';
	if (IPV4.test(host) || host.includes(':')) return 'hostname is an IP address';
	if (!HOSTNAME.test(host)) return 'hostname is not a valid public name';
	return null;
}

function listOf(value: string | string[] | undefined): string[] {
	if (value === undefined) return [];
	const parts = Array.isArray(value) ? value : value.split(/[;|]/);
	return parts.map(bare).filter((part) => part !== '');
}

function clip(value: string | undefined, max: number): string {
	return (value ?? '').trim().slice(0, max);
}

type RawRecord = Partial<Record<keyof InventoryRow, string | string[]>>;

function buildRow(raw: RawRecord): { row: InventoryRow } | { reason: string } {
	const scalar = (key: keyof InventoryRow) => {
		const value = raw[key];
		return typeof value === 'string' ? value : Array.isArray(value) ? value.join(';') : '';
	};
	const host = bare(scalar('hostname'));
	const problem = hostProblem(host);
	if (problem !== null) return { reason: problem };
	const aliases = [...new Set(listOf(raw.aliases))].filter((alias) => alias !== host);
	if (aliases.length > ESTATE_LIMITS.aliasesPerRow) {
		return { reason: `more than ${ESTATE_LIMITS.aliasesPerRow} aliases` };
	}
	for (const alias of aliases) {
		const aliasProblem = hostProblem(alias);
		if (aliasProblem !== null)
			return { reason: `alias ${alias.slice(0, 60)}: ${aliasProblem}` };
	}
	const cms = scalar('cms').trim().toLowerCase();
	if (cms !== '' && !(CMS_VALUES as readonly string[]).includes(cms)) {
		return { reason: 'cms is not drupal, wordpress, joomla or unknown' };
	}
	const uuid = clip(scalar('siteUuid'), 64).toLowerCase();
	if (uuid !== '' && !/^[0-9a-f-]{8,64}$/.test(uuid))
		return { reason: 'site_uuid is not a UUID' };
	return {
		row: {
			hostname: host,
			aliases,
			server: bare(clip(scalar('server'), ESTATE_LIMITS.hostnameChars)),
			docroot: clip(scalar('docroot'), ESTATE_LIMITS.pathChars),
			siteDir: clip(scalar('siteDir'), ESTATE_LIMITS.pathChars),
			databaseHost: bare(clip(scalar('databaseHost'), ESTATE_LIMITS.hostnameChars)),
			databaseName: clip(scalar('databaseName'), ESTATE_LIMITS.pathChars),
			tablePrefix: clip(scalar('tablePrefix'), ESTATE_LIMITS.pathChars),
			siteUuid: uuid,
			cms: (cms === '' ? 'unknown' : cms) as InventoryRow['cms'],
			version: clip(scalar('version'), 40),
			ownerNote: clip(scalar('ownerNote'), ESTATE_LIMITS.noteChars)
		}
	};
}

// records with the line each one starts on; null when a quote never closes
export function parseCsv(text: string): { line: number; cells: string[] }[] | null {
	const records: { line: number; cells: string[] }[] = [];
	let cells: string[] = [];
	let cell = '';
	let quoted = false;
	let line = 1;
	let start = 1;
	let dirty = false;
	const endCell = () => {
		cells.push(cell);
		cell = '';
	};
	const endRecord = () => {
		endCell();
		if (dirty || cells.some((value) => value !== '')) records.push({ line: start, cells });
		cells = [];
		dirty = false;
	};
	const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	for (let i = 0; i < body.length; i++) {
		const char = body[i]!;
		if (quoted) {
			if (char === '"') {
				if (body[i + 1] === '"') {
					cell += '"';
					i++;
				} else quoted = false;
			} else {
				if (char === '\n') line++;
				cell += char;
			}
			continue;
		}
		if (char === '"' && cell === '') {
			quoted = true;
			dirty = true;
		} else if (char === ',') {
			endCell();
			dirty = true;
		} else if (char === '\n' || char === '\r') {
			if (char === '\r' && body[i + 1] === '\n') i++;
			endRecord();
			line++;
			start = line;
		} else cell += char;
	}
	if (quoted) return null;
	if (cell !== '' || cells.length > 0 || dirty) endRecord();
	return records;
}

const fail = (fileError: string): ParsedInventory => ({
	rows: [],
	rejected: [],
	rejectedTotal: 0,
	ignoredColumns: [],
	fileError
});

// never throws; a file that cannot be read at all comes back as one file-level reason
export function parseInventory(input: string): ParsedInventory {
	try {
		return read(input);
	} catch {
		return fail('The file could not be read as an inventory.');
	}
}

function read(input: string): ParsedInventory {
	if (new TextEncoder().encode(input).byteLength > ESTATE_LIMITS.textBytes) {
		return fail('The file is larger than 1 MiB.');
	}
	if (input.includes('\u0000')) return fail('The file does not look like text.');
	const text = input.trim();
	if (text === '') return fail('The file is empty.');
	const sources: { line: number; raw: RawRecord }[] = [];
	const ignored = new Set<string>();
	if (text.startsWith('{') || text.startsWith('[')) {
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			return fail('The file is not valid JSON.');
		}
		const list = Array.isArray(json) ? json : (json as { sites?: unknown })?.sites;
		if (!Array.isArray(list)) return fail('The JSON needs a "sites" list.');
		list.forEach((item, index) => {
			const raw: RawRecord = {};
			if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
				for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
					const name = columnName(key);
					if (!KNOWN_COLUMNS.has(name)) ignored.add(key.slice(0, 40));
					else if (name in COLUMN_KEYS) {
						const column = COLUMN_KEYS[name as keyof typeof COLUMN_KEYS];
						if (typeof value === 'string') raw[column] = unguard(value);
						else if (Array.isArray(value)) {
							raw[column] = value.filter((v): v is string => typeof v === 'string');
						}
					}
				}
			}
			sources.push({ line: index + 1, raw });
		});
	} else {
		const records = parseCsv(text);
		if (records === null) return fail('The file has a quote that never closes.');
		const header = records[0];
		if (header === undefined) return fail('The file is empty.');
		const names = header.cells.map(columnName);
		if (!names.includes('hostname')) return fail('The first row needs a hostname column.');
		names.forEach((name, i) => {
			if (!KNOWN_COLUMNS.has(name)) ignored.add((header.cells[i] ?? '').slice(0, 40));
		});
		for (const record of records.slice(1)) {
			const raw: RawRecord = {};
			names.forEach((name, i) => {
				if (name in COLUMN_KEYS) {
					raw[COLUMN_KEYS[name as keyof typeof COLUMN_KEYS]] = unguard(
						record.cells[i] ?? ''
					);
				}
			});
			sources.push({ line: record.line, raw });
		}
	}
	const rows: ParsedInventory['rows'] = [];
	const rejected: Rejected[] = [];
	let rejectedTotal = 0;
	const reject = (line: number, reason: string) => {
		rejectedTotal++;
		if (rejected.length < ESTATE_LIMITS.rejectedShown) rejected.push({ line, reason });
	};
	for (const { line, raw } of sources) {
		if (rows.length >= ESTATE_LIMITS.rows) {
			reject(
				line,
				`more than ${ESTATE_LIMITS.rows} rows; this row and the rest were left out`
			);
			continue;
		}
		const built = buildRow(raw);
		if ('reason' in built) reject(line, built.reason);
		else rows.push({ line, row: built.row });
	}
	return {
		rows,
		rejected,
		rejectedTotal,
		ignoredColumns: [...ignored].filter((name) => name !== ''),
		fileError: null
	};
}

// #endregion

// #region identity and reconcile

const hashed = async (value: string) => (value === '' ? '' : sha256Hex(value));

export async function sourceSiteIdOf(row: InventoryRow): Promise<SourceSiteId> {
	return {
		hostFingerprint: await hashed(row.server),
		docroots: row.docroot === '' ? [] : [await hashed(row.docroot)],
		siteDirectory: await hashed(row.siteDir),
		siteUri: await hashed(row.hostname),
		databaseEndpoint: await hashed(row.databaseHost),
		schema: row.databaseName,
		prefix: row.tablePrefix,
		siteUuid: row.siteUuid
	};
}

export type IdentityBasis = 'survey' | 'columns' | 'hostname';

// the strongest identity the columns give; a site is the same site when this key matches
export function identityKey(row: InventoryRow): { key: string; basis: IdentityBasis } {
	if (row.siteUuid !== '') return { key: `uuid:${row.siteUuid}`, basis: 'columns' };
	if (
		row.server !== '' &&
		row.siteDir !== '' &&
		row.databaseHost !== '' &&
		row.databaseName !== ''
	) {
		const parts = [
			row.server,
			row.docroot,
			row.siteDir,
			row.databaseHost,
			row.databaseName,
			row.tablePrefix
		];
		return { key: `loc:${parts.join('|')}`, basis: 'columns' };
	}
	return { key: `host:${row.hostname}`, basis: 'hostname' };
}

export interface EstateSite {
	number: number;
	lines: number[];
	input: InventoryRow;
	id: SourceSiteId;
	key: string;
	basis: IdentityBasis;
	reconciled: boolean;
	findings: EstateFinding[];
}

const canonicalRow = (row: InventoryRow) => JSON.stringify(Object.entries(row).sort());

function merge(group: { line: number; row: InventoryRow }[]): InventoryRow {
	const sorted = [...group].sort((a, b) => a.row.hostname.localeCompare(b.row.hostname));
	const base = { ...sorted[0]!.row };
	const names = new Set<string>([base.hostname, ...base.aliases]);
	for (const { row } of sorted.slice(1)) {
		names.add(row.hostname);
		for (const alias of row.aliases) names.add(alias);
		for (const key of Object.keys(base) as (keyof InventoryRow)[]) {
			if (key === 'aliases' || key === 'hostname') continue;
			const current = base[key];
			if ((current === '' || current === 'unknown') && row[key] !== '') {
				(base as Record<string, unknown>)[key] = row[key];
			}
		}
	}
	names.delete(base.hostname);
	base.aliases = [...names].sort().slice(0, ESTATE_LIMITS.aliasesPerRow);
	return base;
}

export const siteInput = (site: EstateSite): InventoryRow => site.input;

// rows are sorted before grouping, so the answer does not depend on the order they arrived in
export async function reconcile(
	rows: readonly { line: number; row: InventoryRow }[]
): Promise<EstateSite[]> {
	const ordered = [...rows].sort(
		(a, b) => canonicalRow(a.row).localeCompare(canonicalRow(b.row)) || a.line - b.line
	);
	const groups = new Map<string, { basis: IdentityBasis; members: typeof ordered }>();
	for (const entry of ordered) {
		const { key, basis } = identityKey(entry.row);
		const group = groups.get(key) ?? { basis, members: [] };
		group.members.push(entry);
		groups.set(key, group);
	}
	const sites: EstateSite[] = [];
	for (const [key, group] of groups) {
		const input = merge(group.members);
		sites.push({
			number: 0,
			lines: group.members.map((member) => member.line).sort((a, b) => a - b),
			input,
			id: await sourceSiteIdOf(input),
			key,
			basis: group.basis,
			reconciled: group.basis !== 'hostname',
			findings: []
		});
	}
	sites.sort(
		(a, b) => a.input.hostname.localeCompare(b.input.hostname) || a.key.localeCompare(b.key)
	);
	sites.forEach((site, index) => (site.number = index + 1));
	addSharedFindings(sites);
	return sites;
}

function addSharedFindings(sites: EstateSite[]): void {
	const byDatabase = new Map<string, EstateSite[]>();
	const byName = new Map<string, EstateSite[]>();
	for (const site of sites) {
		const { databaseHost, databaseName } = site.input;
		if (databaseHost !== '' && databaseName !== '') {
			const key = `${databaseHost}|${databaseName}`;
			byDatabase.set(key, [...(byDatabase.get(key) ?? []), site]);
		}
		for (const name of new Set([site.input.hostname, ...site.input.aliases])) {
			byName.set(name, [...(byName.get(name) ?? []), site]);
		}
	}
	for (const shared of byDatabase.values()) {
		if (shared.length < 2) continue;
		for (const site of shared) {
			const others = shared.filter((other) => other !== site).map((other) => other.number);
			site.findings.push({
				status: 'requires choice',
				title: 'Shared Database',
				detail: `This site shares its database with ${others.length === 1 ? 'row' : 'rows'} ${others.join(', ')}. Each site moves on its own, so decide whether they move together.`
			});
		}
	}
	for (const [name, owners] of byName) {
		if (owners.length < 2) continue;
		const [first, ...rest] = owners;
		first!.findings.push({
			status: 'requires choice',
			title: 'Duplicate Domain',
			detail: `${name} is listed on rows ${owners.map((o) => o.number).join(', ')}. It can point at one site only.`
		});
		for (const site of rest) {
			site.findings.push({
				status: 'information',
				title: 'Duplicate Domain',
				detail: `${name} is also listed on row ${first!.number}.`
			});
		}
	}
}

// #endregion

// #region classify

export interface Evidence {
	preflight: PreflightResult | null;
	dossier: Dossier | null;
	// the server group has no key or no confirmed host key
	access: 'none' | 'ready';
	// what is missing when access is none and the usual line would mislead
	gap?: string;
	// the domain is beyond the unproven check allowance
	needsProof: string | null;
}

const NOT_SUPPORTED = 'Not supported yet';

function majorOf(version: string): number | null {
	const match = /^(\d+)/.exec(version.trim());
	return match === null ? null : Number(match[1]);
}

function missingAccess(site: EstateSite): string {
	const { server } = site.input;
	return server === ''
		? 'an SSH key for the server this site runs on'
		: `an SSH key for ${server}, with its host key confirmed`;
}

function cmsFindings(cms: string, from: string): EstateFinding[] {
	if (cms === 'wordpress' || cms === 'joomla') {
		const name = cms === 'wordpress' ? 'WordPress' : 'Joomla';
		return [
			{
				status: 'unsupported',
				title: name,
				detail: `${NOT_SUPPORTED}. ${from} says this is ${name}.`
			}
		];
	}
	return [];
}

// one verdict per site; a survey outranks the public check, which outranks the inventory columns
export function classifySite(site: EstateSite, evidence: Evidence): RowVerdict {
	const findings: EstateFinding[] = [...site.findings];
	const finish = (
		rowClass: RowClass,
		state: RowState,
		missing: string | null,
		basis: IdentityBasis = site.basis
	): RowVerdict => ({
		class: rowClass,
		state,
		basis,
		reconciled: basis !== 'hostname',
		missing,
		findings
	});

	if (evidence.needsProof !== null) {
		findings.push({
			status: 'information',
			title: 'Domain Not Proven',
			detail: `Only ${ESTATE_LIMITS.unprovenHostsPerRun} sites on domains you have not proven are checked. Prove ${evidence.needsProof} to check this one.`
		});
		return finish(
			'information',
			'needs proof',
			`proof that you control ${evidence.needsProof}`
		);
	}

	const declared = site.input.cms;
	const seen = evidence.preflight?.cms ?? 'unknown';
	const cms = seen !== 'unknown' ? seen : declared;
	let state: RowState = 'done';
	let missing: string | null = null;
	let rowClass: RowClass = 'information';
	let basis = site.basis;

	if (evidence.dossier !== null) {
		const dossier = evidence.dossier;
		basis = 'survey';
		for (const finding of dossier.findings) findings.push(finding);
		if (dossier.verdict === 'needs upgrade') rowClass = 'automatic upgrade';
		else if (dossier.verdict === 'refused') rowClass = 'unsupported';
		else
			rowClass = dossier.findings.some((f) => f.status === 'requires choice')
				? 'needs decision'
				: 'ready';
		if (rowClass === 'unsupported') {
			for (const reason of dossier.refusals) {
				if (!findings.some((f) => f.detail === reason)) {
					findings.push({
						status: 'unsupported',
						title: 'Cannot Import Yet',
						detail: reason
					});
				}
			}
		}
	} else {
		findings.push(
			...cmsFindings(cms, seen !== 'unknown' ? 'The public page' : 'Your inventory')
		);
		if (evidence.preflight !== null) {
			for (const note of evidence.preflight.notes) {
				findings.push({ status: 'information', title: 'Public Check', detail: note });
			}
			if (!evidence.preflight.reachable) {
				findings.push({
					status: 'information',
					title: 'Did Not Answer',
					detail: 'The site did not answer the public check.'
				});
			}
		}
		const version =
			evidence.preflight?.version ?? (site.input.version === '' ? null : site.input.version);
		const major = version === null ? null : majorOf(version);
		if (cms === 'wordpress' || cms === 'joomla') rowClass = 'unsupported';
		else if (cms === 'drupal' && major !== null && major < DRUPAL_MAJOR) {
			rowClass = 'automatic upgrade';
			findings.push({
				status: 'unsupported',
				title: 'Needs Upgrade',
				detail: `Drupal ${version} is older than Drupal ${DRUPAL_MAJOR}. The upgrade comes first.`
			});
		} else if (cms === 'drupal' && major !== null && major > DRUPAL_MAJOR) {
			rowClass = 'unsupported';
			findings.push({
				status: 'unsupported',
				title: 'Drupal Version',
				detail: `Drupal ${version} is newer than the Drupal ${DRUPAL_MAJOR} that imports today.`
			});
		} else {
			findings.push({
				status: 'information',
				title: 'Needs a Server Survey',
				detail: 'Only a read-only survey of the server can say whether this site is ready.'
			});
			state = 'needs access';
			missing = evidence.access === 'ready' ? null : (evidence.gap ?? missingAccess(site));
		}
	}

	if (rowClass !== 'unsupported' && findings.some((f) => f.status === 'requires choice')) {
		rowClass = 'needs decision';
	}
	if (rowClass === 'ready' && findings.some((f) => f.status === 'unsupported')) {
		rowClass = 'unsupported';
	}
	return finish(rowClass, state, missing, basis);
}

// #endregion

// #region report and export

// a row the check could not finish; the reason is plain text with nothing from the server in it
export function couldNotCheck(site: EstateSite, reason: string): RowVerdict {
	return {
		class: 'information',
		state: 'could not check',
		basis: site.basis,
		reconciled: site.basis !== 'hostname',
		missing: null,
		findings: [
			...site.findings,
			{ status: 'information', title: 'Could Not Check', detail: reason.slice(0, 200) }
		]
	};
}

export interface ReportRow {
	site: EstateSite;
	verdict: RowVerdict;
}

const EFFORT_REASON =
	'Effort needs a measured run. This assessment only read the sites, so it states no hours.';

export function aggregate(rows: readonly ReportRow[]): EstateReport {
	const byClass = Object.fromEntries(ROW_CLASSES.map((name) => [name, 0])) as Record<
		RowClass,
		number
	>;
	const byState = Object.fromEntries(ROW_STATES.map((name) => [name, 0])) as Record<
		RowState,
		number
	>;
	let notReconciled = 0;
	let surveyed = 0;
	const databases = new Map<string, number>();
	const names = new Map<string, number>();
	for (const { site, verdict } of rows) {
		byClass[verdict.class]++;
		byState[verdict.state]++;
		if (!verdict.reconciled) notReconciled++;
		if (verdict.basis === 'survey') surveyed++;
		const { databaseHost, databaseName } = site.input;
		if (databaseHost !== '' && databaseName !== '') {
			const key = `${databaseHost}|${databaseName}`;
			databases.set(key, (databases.get(key) ?? 0) + 1);
		}
		for (const name of new Set([site.input.hostname, ...site.input.aliases])) {
			names.set(name, (names.get(name) ?? 0) + 1);
		}
	}
	return {
		counts: {
			sites: rows.length,
			byClass,
			byState,
			notReconciled,
			sharedDatabases: [...databases.values()].filter((count) => count > 1).length,
			duplicateDomains: [...names.values()].filter((count) => count > 1).length,
			surveyed
		},
		effort: { value: null, label: 'Not estimated', reason: EFFORT_REASON },
		windows: { value: null, label: 'Not estimated' }
	};
}

const cell = (value: string) => {
	const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
	return /[",\n\r]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
};

// the inventory columns come first, so the file is a valid inventory again
export function toCsv(rows: readonly ReportRow[]): string {
	const head = [...INVENTORY_COLUMNS, ...REPORT_COLUMNS].join(',');
	const lines = rows.map(({ site, verdict }) => {
		const input = site.input;
		const values = INVENTORY_COLUMNS.map((column) => {
			const value = input[COLUMN_KEYS[column]];
			return Array.isArray(value) ? value.join(';') : value;
		});
		values.push(
			String(site.number),
			verdict.class,
			verdict.state,
			verdict.basis,
			verdict.reconciled ? 'yes' : 'Not reconciled',
			verdict.findings.map((f) => `${f.title}: ${f.detail}`).join(' | '),
			verdict.missing ?? '',
			'Not estimated'
		);
		return values.map(cell).join(',');
	});
	return `${[head, ...lines].join('\r\n')}\r\n`;
}

// #endregion

// #region proof allowance

export const domainOf = (site: EstateSite) => registrableDomain(site.input.hostname);

// the first sites, by number, on unproven domains are checked; the rest wait for proof
export function proofAllowance(
	sites: readonly EstateSite[],
	proven: ReadonlySet<string>
): Map<number, string | null> {
	const out = new Map<number, string | null>();
	let used = 0;
	for (const site of [...sites].sort((a, b) => a.number - b.number)) {
		const domain = domainOf(site);
		if (proven.has(domain)) out.set(site.number, null);
		else if (used < ESTATE_LIMITS.unprovenHostsPerRun) {
			used++;
			out.set(site.number, null);
		} else out.set(site.number, domain);
	}
	return out;
}

// #endregion

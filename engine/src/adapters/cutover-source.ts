import { utf8 } from '@contracts/common';
import { DEFAULT_RESTORE_CEILING_BYTES } from '../backup-parts';
import {
	CACHE_STRUCTURE_ONLY,
	DUMP_LIMIT_FACTOR,
	ImportError,
	PART_BYTES,
	partKey,
	readWindow
} from '../import-parts';
import type { BackupBlobs, CutoverSource, DumpStream, ImportStore, SqlConverter } from '../ports';
import { PermanentError } from '../step';
import { deltaTables, EXCLUDED_FROM_DELTA, reseedStatement } from '../vendor/drangler/delta';
import { DNS_UNREADABLE, type DnsReader } from './cutover-dns';
import {
	copyManifestSchema,
	cutoverKeys,
	digestOfParts,
	keyParts,
	manifestOfMarker,
	markerOf,
	parseSourceRef,
	readManifest,
	sha256Hex,
	writeManifest,
	type CopyLabel,
	type CopyManifest
} from './cutover-store';
import { openSession } from './ssh-session';
import type { SshConnector } from './ssh-survey';

export interface CutoverSourceDeps {
	imports: ImportStore;
	connector: SshConnector;
	dump: DumpStream;
	converter: SqlConverter;
	blobs: BackupBlobs;
	dns: DnsReader;
	now(): number;
	partBytes?: number;
	maxDumpBytes?: number;
}

export const READ_ONLY_MODULE = 'readonlymode';

export const SOURCE_REFUSALS = {
	badRef: 'The reference of your old site is not one Drupflare can read. It is a key, then the folder of the site.',
	readOnlyUnavailable:
		'Your old site has no Read Only Mode module, so it cannot be set to read only. Choose the freeze, or add the module first.',
	policyNotHeld:
		'Your old site did not take the write policy. Check that its maintenance setting can be changed.',
	writesNotBack:
		'Your old site did not take writes again. Turn off its maintenance mode by hand.',
	commandFailed: 'A command on your old server did not finish cleanly.',
	noRecords: 'Drupflare found no DNS records for your address, so there is nothing to move.',
	markerUnknown: 'The copy this change builds on is no longer in storage.'
} as const;

interface PolicyRecord {
	policy: 'freeze' | 'read-only' | 'delta';
	// what the setting held before the policy, so a restore puts back the owner's own value
	previous: string;
	restored: boolean;
}

export const STRUCTURE_ONLY = [...CACHE_STRUCTURE_ONLY, ...Object.keys(EXCLUDED_FROM_DELTA)];

const tablePattern = /^[A-Za-z0-9_]+$/;
const shq = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function createCutoverSource(
	deps: CutoverSourceDeps,
	ref: string,
	orgId: string
): CutoverSource {
	const parsed = parseSourceRef(ref);
	const { blobs } = deps;
	const partBytes = deps.partBytes ?? PART_BYTES;
	const maxDump = deps.maxDumpBytes ?? DEFAULT_RESTORE_CEILING_BYTES * DUMP_LIMIT_FACTOR;
	const need = () => {
		if (parsed === null) throw new PermanentError('source_ref', SOURCE_REFUSALS.badRef);
		return parsed;
	};

	// one command on the old server; the answer is the exit code and stdout, never stderr
	const exec = async (command: string): Promise<{ code: number; out: string }> => {
		const { credentialId, root } = need();
		return deps.imports.withTarget(credentialId, orgId, root, async (target) => {
			const session = await openSession(deps.connector, target);
			try {
				const result = await session.exec(`cd ${shq(root)} && ${command}`);
				return { code: result.code, out: result.stdoutText };
			} finally {
				await session.close().catch(() => undefined);
			}
		});
	};

	const must = async (command: string): Promise<string> => {
		const { code, out } = await exec(command);
		if (code !== 0) throw new PermanentError('source_command', SOURCE_REFUSALS.commandFailed);
		return out;
	};

	// #region copies

	async function convert(
		copy: string,
		dumped: { bytes: number }
	): Promise<{ parts: number; bytes: number; hashes: string[] }> {
		const hashes: string[] = [];
		let offset = 0;
		let seq = 0;
		let bytes = 0;
		while (offset < dumped.bytes) {
			const window = await readWindow(
				blobs,
				(part) => partKey(cutoverKeys.dump(copy), part, 'sql'),
				partBytes,
				dumped.bytes,
				offset,
				partBytes
			);
			const last = offset + window.byteLength >= dumped.bytes;
			const converted = await deps.converter.convertChunk(window, last);
			if (converted.cut <= 0) {
				throw new ImportError('dump_failed', 'a conversion step made no progress');
			}
			const sql = utf8(converted.sql);
			await blobs.put(partKey(cutoverKeys.sql(copy), seq, 'sql'), sql);
			hashes.push(await sha256Hex(sql));
			bytes += sql.byteLength;
			offset += converted.cut;
			seq++;
		}
		return { parts: seq, bytes, hashes };
	}

	// a repeat with the same key finds the manifest the first run wrote last and sends no command
	async function copyOf(
		key: string,
		label: CopyLabel,
		tables: () => Promise<string[] | null>,
		tail: string | null
	): Promise<{ marker: string }> {
		const { operationId } = keyParts(key);
		const copy = cutoverKeys.copy(orgId, operationId, label);
		const kept = await readManifest(blobs, copy);
		if (kept !== null) return { marker: markerOf(kept) };
		const { credentialId, root } = need();
		const only = await tables();
		const dumped = await deps.imports.withTarget(credentialId, orgId, root, (target) =>
			deps.dump.run(target, {
				kind: 'database',
				prefix: cutoverKeys.dump(copy),
				partBytes,
				maxBytes: maxDump,
				...(only === null ? { structureOnly: STRUCTURE_ONLY } : {}),
				...(only === null ? {} : { tables: only })
			})
		);
		if (dumped.bytes === 0) {
			throw new ImportError('dump_empty', 'the server returned an empty database dump');
		}
		await blobs.deletePrefix(cutoverKeys.sql(copy));
		const converted = await convert(copy, dumped);
		const hashes = [...converted.hashes];
		let parts = converted.parts;
		let bytes = converted.bytes;
		if (tail !== null) {
			const extra = utf8(`\n${tail}\n`);
			await blobs.put(partKey(cutoverKeys.sql(copy), parts, 'sql'), extra);
			hashes.push(await sha256Hex(extra));
			parts++;
			bytes += extra.byteLength;
		}
		const manifest: CopyManifest = copyManifestSchema.parse({
			label,
			parts,
			bytes,
			digest: await digestOfParts(hashes),
			tables: only,
			takenAt: deps.now()
		});
		await writeManifest(blobs, copy, manifest);
		return { marker: markerOf(manifest) };
	}

	// #endregion

	// #region write policy

	const readPolicy = async (operationId: string): Promise<PolicyRecord | null> => {
		const bytes = await blobs.get(cutoverKeys.policy(orgId, operationId));
		if (bytes === null) return null;
		try {
			return JSON.parse(new TextDecoder().decode(bytes)) as PolicyRecord;
		} catch {
			return null;
		}
	};

	const writePolicy = (operationId: string, record: PolicyRecord) =>
		blobs.put(cutoverKeys.policy(orgId, operationId), utf8(JSON.stringify(record)));

	const MAINTENANCE = 'system.maintenance_mode';
	const readMaintenance = async () => (await must(`drush state:get ${MAINTENANCE}`)).trim();
	const readReadOnly = async () =>
		(
			await must(`drush config:get ${READ_ONLY_MODULE}.settings enabled --format=string`)
		).trim();

	// #endregion

	return {
		async lowerTtl(_key, hostname, ttlSeconds) {
			let found;
			try {
				found = await deps.dns.lookup(hostname);
			} catch {
				throw new Error(DNS_UNREADABLE);
			}
			if (found.ttl === null)
				throw new PermanentError('no_dns_records', SOURCE_REFUSALS.noRecords);
			return { previousTtlSeconds: Math.max(found.ttl, ttlSeconds) };
		},

		// the zone is the owner's, so putting the cache time back is a step the owner does
		async restoreTtl() {},

		snapshot: (key) => copyOf(key, 'snapshot', async () => null, null),

		async delta(key, since) {
			const { operationId, label } = keyParts(key);
			if (label !== 'capture-delta' && label !== 'final-delta') {
				throw new PermanentError(
					'cutover_key',
					'a change copy needs a capture or final step key'
				);
			}
			if ((await manifestOfMarker(blobs, orgId, operationId, since)) === null) {
				throw new PermanentError('marker_unknown', SOURCE_REFUSALS.markerUnknown);
			}
			return copyOf(
				key,
				label,
				async () => {
					const listed = (await must('drush sql:query "SHOW TABLES"'))
						.split('\n')
						.map((line) => line.trim())
						.filter((line) => tablePattern.test(line));
					const wanted = deltaTables(listed).filter((table) => listed.includes(table));
					if (wanted.length === 0) {
						throw new PermanentError('source_command', SOURCE_REFUSALS.commandFailed);
					}
					return wanted;
				},
				reseedStatement()
			);
		},

		async applyWritePolicy(key, policy) {
			const { operationId } = keyParts(key);
			if (policy === 'read-only') {
				const modules = await must(
					'drush pm:list --status=enabled --type=module --field=name'
				);
				if (!modules.split('\n').some((line) => line.trim() === READ_ONLY_MODULE)) {
					throw new PermanentError(
						'read_only_unavailable',
						SOURCE_REFUSALS.readOnlyUnavailable
					);
				}
			}
			// the owner's own value is saved before the first change, and a repeat keeps it
			const kept = await readPolicy(operationId);
			const previous =
				kept?.previous ??
				(policy === 'read-only' ? await readReadOnly() : await readMaintenance());
			await writePolicy(operationId, { policy, previous, restored: false });
			if (policy === 'read-only') {
				await must(`drush config:set -y ${READ_ONLY_MODULE}.settings enabled 1`);
				if (!/^(1|true)$/i.test(await readReadOnly())) {
					throw new PermanentError('policy_not_held', SOURCE_REFUSALS.policyNotHeld);
				}
				return;
			}
			await must(`drush state:set ${MAINTENANCE} 1`);
			if ((await readMaintenance()) !== '1') {
				throw new PermanentError('policy_not_held', SOURCE_REFUSALS.policyNotHeld);
			}
		},

		async restoreWrites(key) {
			const { operationId } = keyParts(key);
			const record = await readPolicy(operationId);
			if (record === null || record.restored) return;
			if (record.policy === 'read-only') {
				const off = /^(1|true)$/i.test(record.previous) ? '1' : '0';
				await must(`drush config:set -y ${READ_ONLY_MODULE}.settings enabled ${off}`);
			} else if (record.previous === '') {
				await must(`drush state:delete ${MAINTENANCE}`);
			} else {
				await must(`drush state:set ${MAINTENANCE} ${shq(record.previous)}`);
			}
			if (record.policy !== 'read-only' && (await readMaintenance()) !== record.previous) {
				throw new PermanentError('writes_not_back', SOURCE_REFUSALS.writesNotBack);
			}
			await writePolicy(operationId, { ...record, restored: true });
		}
	};
}

import type { D1Database } from '@cloudflare/workers-types';
import { decryptRecordText, loadKeyRing, type KeyRing } from '../../../src/shared/custody/envelope';
import {
	credentialRefusal,
	IMPORT_CREDENTIAL_SQL,
	importCredentialAad
} from '../../../src/shared/custody/import-credentials';
import { ImportError } from '../import-parts';
import type { ImportStore } from '../ports';

export interface ImportStoreOptions {
	db: D1Database;
	// the `KEK_V<n>` secrets; read when the first key is opened, not at start
	secrets: Readonly<Record<string, string | undefined>>;
	now(): number;
}

interface CredentialRow {
	key_envelope: string;
	host: string;
	port: number;
	username: string;
	host_key_fingerprint: string | null;
	expires_at: number;
}

// one record format with the dashboard's import routes: same table, same statements, same
// associated data. The key is opened for the length of one call and the plain text is never kept
export function importStoreOf(options: ImportStoreOptions): ImportStore {
	const { db, now } = options;
	let ring: Promise<KeyRing> | undefined;
	const keys = async () => {
		ring ??= loadKeyRing(options.secrets);
		try {
			return await ring;
		} catch (error) {
			ring = undefined;
			throw error;
		}
	};

	return {
		async withTarget(credentialId, orgId, root, use) {
			const row = await db
				.prepare(IMPORT_CREDENTIAL_SQL.select)
				.bind(orgId, credentialId)
				.first<CredentialRow>();
			if (row === null) {
				throw new ImportError(
					'credential_missing',
					'the import credential is gone or belongs to another organization'
				);
			}
			const refusal = credentialRefusal(
				{ expiresAt: row.expires_at, hostKeyFingerprint: row.host_key_fingerprint },
				now()
			);
			if (refusal === 'expired') {
				throw new ImportError('credential_expired', 'the import credential has expired');
			}
			if (row.host_key_fingerprint === null || refusal !== null) {
				throw new ImportError(
					'host_key_unconfirmed',
					'the host key of the server was not confirmed'
				);
			}
			let envelope: unknown;
			try {
				envelope = JSON.parse(row.key_envelope);
			} catch {
				throw new ImportError(
					'credential_missing',
					'the stored import credential is not an envelope'
				);
			}
			const privateKey = await decryptRecordText(
				envelope,
				importCredentialAad(credentialId),
				await keys()
			);
			await db.prepare(IMPORT_CREDENTIAL_SQL.markUsed).bind(now(), credentialId).run();
			return use({
				host: row.host,
				port: row.port,
				user: row.username,
				privateKey,
				expectedFingerprint: row.host_key_fingerprint,
				root
			});
		},

		async discard(credentialId) {
			await db.prepare(IMPORT_CREDENTIAL_SQL.discard).bind(credentialId).run();
		},

		async markImported(siteId, credentialId, accountId, at) {
			await db
				.prepare(
					`UPDATE sites SET imported_from = (${IMPORT_CREDENTIAL_SQL.hostOf}),
					 account_id = ?, updated_at = ?
					 WHERE id = ? AND EXISTS (SELECT 1 FROM import_credentials WHERE id = ?)`
				)
				.bind(credentialId, accountId, at, siteId, credentialId)
				.run();
		}
	};
}

import type { D1Database } from '@cloudflare/workers-types';
import {
	decryptRecordText,
	encryptRecord,
	loadKeyRing,
	type KeyRing
} from '../../../src/shared/custody/envelope';
import {
	OWNER_TOKEN_SQL,
	ownerTokenAad,
	ownerTokenIdOf,
	PENDING_SECRET_SQL,
	pendingSecretAad,
	pendingSecretIdOf
} from '../../../src/shared/custody/records';
import { ConfigError } from '../config';
import { CustodyError, type Custody } from '../custody';

export interface CustodyOptions {
	db: D1Database;
	// the `KEK_V<n>` secrets; read when the first secret is sealed or opened, not at start
	secrets: Readonly<Record<string, string | undefined>>;
	pendingTtlMs: number;
	now(): number;
}

// one record format with the dashboard's owner-tokens service: same table, same statements, same
// associated data, so what the engine seals the dashboard reveals
export function custodyOf(options: CustodyOptions): Custody {
	const { db, now } = options;
	if (!Number.isSafeInteger(options.pendingTtlMs) || options.pendingTtlMs <= 0) {
		throw new ConfigError('PENDING_SECRET_TTL_MS');
	}
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
	const hasOwnerToken = async (siteId: string) =>
		(await db.prepare(OWNER_TOKEN_SQL.exists).bind(siteId).first()) !== null;

	return {
		async sealed(siteId) {
			const pending = await db.prepare(PENDING_SECRET_SQL.exists).bind(siteId).all<{
				kind: string;
			}>();
			return {
				ownerTokenId: (await hasOwnerToken(siteId)) ? ownerTokenIdOf(siteId) : null,
				pendingSecretId: pending.results.some((row) => row.kind === 'admin-password')
					? pendingSecretIdOf(siteId, 'admin-password')
					: null
			};
		},

		async sealOwnerToken(siteId, token) {
			const current = JSON.stringify(
				await encryptRecord(token, ownerTokenAad(siteId), await keys())
			);
			const existing = await db
				.prepare(OWNER_TOKEN_SQL.select)
				.bind(siteId)
				.first<{ version: number }>();
			const written = existing
				? await db
						.prepare(OWNER_TOKEN_SQL.update)
						.bind(current, null, now(), siteId, existing.version)
						.first()
				: await db
						.prepare(OWNER_TOKEN_SQL.insert)
						.bind(siteId, current, null, now())
						.first();
			if (written === null) {
				throw new CustodyError('conflict', 'the owner token changed while it was sealed');
			}
			return ownerTokenIdOf(siteId);
		},

		async sealPendingSecret(siteId, kind, value) {
			const ciphertext = await encryptRecord(
				value,
				pendingSecretAad(siteId, kind),
				await keys()
			);
			const at = now();
			await db
				.prepare(PENDING_SECRET_SQL.seal)
				.bind(
					siteId,
					kind,
					JSON.stringify(ciphertext),
					ciphertext.kv,
					at,
					at + options.pendingTtlMs
				)
				.run();
			return pendingSecretIdOf(siteId, kind);
		},

		async withOwnerToken(siteId, ownerTokenId, use) {
			if (ownerTokenId !== ownerTokenIdOf(siteId)) {
				throw new CustodyError('unknown_id', 'that id does not name this site owner token');
			}
			const row = await db
				.prepare(OWNER_TOKEN_SQL.select)
				.bind(siteId)
				.first<{ current_envelope: string }>();
			if (row === null) throw new CustodyError('not_sealed', 'no owner token is sealed');
			let envelope: unknown;
			try {
				envelope = JSON.parse(row.current_envelope);
			} catch {
				throw new CustodyError('bad_record', 'the stored owner token is not an envelope');
			}
			return use(await decryptRecordText(envelope, ownerTokenAad(siteId), await keys()));
		},

		async discardPending(siteId) {
			await db.prepare(PENDING_SECRET_SQL.discard).bind(siteId).run();
		},

		async discard(siteId) {
			await db.batch([
				db.prepare(OWNER_TOKEN_SQL.discard).bind(siteId),
				db.prepare(PENDING_SECRET_SQL.discard).bind(siteId)
			]);
		}
	};
}

import type { D1Database } from '@cloudflare/workers-types';
import { isEnvironmentStatus } from '../../../src/shared/environments';
import type { EnvironmentStore, VerificationStore } from '../ports';
import { PermanentError } from '../step';

export class D1CopyStore implements EnvironmentStore, VerificationStore {
	constructor(private readonly db: D1Database) {}

	async setStatus(
		organizationId: string,
		id: string,
		status: string,
		now: number
	): Promise<void> {
		if (!isEnvironmentStatus(status)) {
			throw new PermanentError(
				'environment_status',
				`${status} is not an environment status`
			);
		}
		await this.db
			.prepare(
				`UPDATE site_environments SET status = ?, deleted_at = ?
				 WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`
			)
			.bind(status, status === 'deleted' ? now : null, organizationId, id)
			.run();
	}

	async markVerified(organizationId: string, backupId: string, _now: number): Promise<void> {
		await this.db
			.prepare('UPDATE backups SET verified = 1 WHERE organization_id = ? AND id = ?')
			.bind(organizationId, backupId)
			.run();
	}
}

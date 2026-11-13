import type { Operation } from '@contracts/operations';
import { defineStore } from 'pinia';
import { useApi } from '~/composables/useApi';
import { useOperationsStore } from '~/stores/operations';

export interface ImportCredential {
	id: string;
	publicKey: string;
	host: string;
	port: number;
	username: string;
	expiresAt: string;
}

export interface ImportHostKey {
	credentialId: string;
	hostKeyType: string;
	fingerprint: string;
	confirmed: boolean;
}

export interface ImportFinding {
	status: 'automatic' | 'requires choice' | 'unsupported' | 'information';
	title: string;
	detail: string;
}

export interface ImportDossier {
	verdict: 'ready' | 'needs upgrade' | 'refused';
	importable: boolean;
	refusals: string[];
	estimate: { bytes: number; fileCount: number };
	findings: ImportFinding[];
}

export interface ImportSurvey {
	v: 1;
	host: string;
	root: string;
	capturedAt: string;
	dossier: ImportDossier;
}

const base = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/imports`;

export const useImportsStore = defineStore('imports', {
	state: () => ({
		// the public key is returned once and kept only in this session's memory
		credential: null as ImportCredential | null,
		// keyed by survey operation id; undefined: not loaded; null: known absent; an object: loaded
		surveys: new Map<string, ImportSurvey | null>()
	}),
	actions: {
		async createCredential(
			orgId: string,
			body: { host: string; port: number; username: string }
		): Promise<ImportCredential> {
			const credential = await useApi().post<ImportCredential>(
				`${base(orgId)}/credentials`,
				body
			);
			this.credential = credential;
			return credential;
		},
		readHostKey(
			orgId: string,
			credentialId: string,
			confirmFingerprint?: string
		): Promise<ImportHostKey> {
			return useApi().post<ImportHostKey>(`${base(orgId)}/hostkey`, {
				credentialId,
				...(confirmFingerprint === undefined
					? {}
					: { confirm: { fingerprint: confirmFingerprint } })
			});
		},
		startSurvey(
			orgId: string,
			credentialId: string,
			root: string,
			idempotencyKey: string
		): Promise<Operation> {
			return useApi().post<Operation>(
				`${base(orgId)}/survey`,
				{ credentialId, root },
				{ 'Idempotency-Key': idempotencyKey }
			);
		},
		// a survey that is still running returns its operation with no survey yet
		async readSurvey(orgId: string, operationId: string): Promise<Operation | null> {
			const operation = await useOperationsStore().fetchOne(orgId, operationId);
			if (operation === null) {
				this.surveys.set(operationId, null);
				return null;
			}
			if (operation.status === 'succeeded' && operation.cursor) {
				this.surveys.set(operationId, JSON.parse(operation.cursor) as ImportSurvey);
			}
			return operation;
		},
		startImport(
			orgId: string,
			body: { credentialId: string; surveyId: string; name: string },
			idempotencyKey: string
		): Promise<Operation> {
			return useApi().post<Operation>(base(orgId), body, {
				'Idempotency-Key': idempotencyKey
			});
		},
		reset(): void {
			this.credential = null;
			this.surveys.clear();
		}
	}
});

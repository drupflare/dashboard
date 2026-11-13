import { newId, publicKeySchema } from '@contracts/common';
import {
	claimResponseSchema,
	hashClaimToken,
	type claimRequestSchema
} from '@contracts/fleet-link';
import type { CollegeDBClient } from '@earth-app/collegedb';
import type { z } from 'zod';
import type { NodeRecord } from '../../../engine/src/node-store';
import { ApiError } from '../../shared/errors';
import type { NodeView, PairingView } from '../../shared/nodes';
import { DuplicateRowError } from '../db/collegedb';
import {
	findPairingByHash,
	insertNode,
	insertPairing,
	markPairingClaimed,
	releasePairing
} from '../db/repos/nodes';
import { claimDecision, createPairing, type ClaimRefusal } from '../domain/fleet';
import type { AuditInput } from './audit';

export interface FleetServices {
	getDb: () => Promise<CollegeDBClient>;
	audit: (orgId: string, input: AuditInput) => Promise<unknown>;
	// the dashboard's origin, where a box finds the claim route
	baseUrl: string;
	// the wss origin of the link host; null until one is provisioned
	linkOrigin: string | null;
	// the public half of the key the link signs commands with; null until provisioned
	dashboardPublicKey: string | null;
	now: () => number;
}

const notBuilt = (what: string) => async (): Promise<never> => {
	throw new ApiError('not_built', `${what} is not available yet`);
};

function productionServices(): FleetServices {
	return {
		getDb: notBuilt('The node store'),
		audit: notBuilt('The audit log'),
		baseUrl: 'https://app.drupflare.com',
		linkOrigin: null,
		dashboardPublicKey: null,
		now: Date.now
	};
}

let installed = productionServices();

export function setFleetServices(over: Partial<FleetServices>): void {
	installed = { ...installed, ...over };
}

export function resetFleetServices(): void {
	installed = productionServices();
}

export function fleetServices(): FleetServices {
	return installed;
}

const text = (env: Record<string, unknown>, name: string): string | null => {
	const value = env[name];
	return typeof value === 'string' && value !== '' ? value : null;
};

// a link origin has to be a ws or wss origin, so a typo cannot hand a box an http address; a bad
// value leaves pairing unavailable and never stops the dashboard from booting
export function fleetConfigOf(
	env: Record<string, unknown>
): Pick<FleetServices, 'linkOrigin' | 'dashboardPublicKey'> {
	const raw = text(env, 'FLEET_LINK_ORIGIN');
	let linkOrigin: string | null = null;
	try {
		const url = raw === null ? null : new URL(raw);
		if (url !== null && (url.protocol === 'wss:' || url.protocol === 'ws:')) {
			linkOrigin = url.origin;
		}
	} catch {
		linkOrigin = null;
	}
	const key = text(env, 'FLEET_PUBLIC_KEY');
	return {
		linkOrigin,
		dashboardPublicKey: key !== null && publicKeySchema.safeParse(key).success ? key : null
	};
}

function requireLink(services: FleetServices): { linkOrigin: string; dashboardPublicKey: string } {
	const { linkOrigin, dashboardPublicKey } = services;
	if (linkOrigin === null || dashboardPublicKey === null) {
		throw new ApiError('not_built', 'Pairing a node is not available yet');
	}
	return { linkOrigin, dashboardPublicKey };
}

// #region pairing

export async function startPairing(
	services: FleetServices,
	input: { orgId: string; actor: string }
): Promise<PairingView> {
	requireLink(services);
	const now = services.now();
	const { pairing, token } = await createPairing({ orgId: input.orgId, now });
	await insertPairing(await services.getDb(), pairing, input.actor);
	return {
		pairingId: pairing.id,
		claimToken: token,
		pairUrl: `${services.baseUrl.replace(/\/+$/, '')}/p#${token}`,
		expiresAt: new Date(pairing.expiresAt).toISOString()
	};
}

const CLAIM_MESSAGE: Record<ClaimRefusal, string> = {
	invalid_token: 'This pairing code is not valid.',
	expired: 'This pairing code has expired. Start a new pairing from the dashboard.',
	already_claimed: 'This pairing code was already used. Start a new pairing from the dashboard.',
	revoked: 'This pairing was cancelled. Start a new pairing from the dashboard.'
};

export async function claimNode(
	services: FleetServices,
	request: z.infer<typeof claimRequestSchema>
): Promise<z.infer<typeof claimResponseSchema>> {
	const { linkOrigin, dashboardPublicKey } = requireLink(services);
	const db = await services.getDb();
	const now = services.now();
	const pairing = await findPairingByHash(db, await hashClaimToken(request.claimToken));
	const decision = await claimDecision(pairing, request.claimToken, now);
	if (!decision.ok || pairing === null) {
		const code = decision.ok ? 'invalid_token' : decision.code;
		throw new ApiError(
			code === 'invalid_token' ? 'not_found' : 'conflict',
			CLAIM_MESSAGE[code],
			{
				reason: code
			}
		);
	}
	const nodeId = newId('nod');
	// the pairing row decides the single winner; a failed node write puts the pairing back
	if (!(await markPairingClaimed(db, pairing.id, nodeId, now))) {
		throw new ApiError('conflict', CLAIM_MESSAGE.already_claimed, {
			reason: 'already_claimed'
		});
	}
	try {
		await insertNode(db, {
			id: nodeId,
			orgId: pairing.orgId,
			publicKey: request.nodePublicKey,
			hostFacts: request.hostFacts,
			now
		});
	} catch (error) {
		await releasePairing(db, pairing.id, nodeId).catch(() => false);
		if (error instanceof DuplicateRowError) {
			throw new ApiError('conflict', 'This node is already paired.', { reason: 'duplicate' });
		}
		throw error;
	}
	await services.audit(pairing.orgId, {
		actor: `node:${nodeId}`,
		action: 'node.claim',
		target: nodeId,
		detail: { pairingId: pairing.id, hostname: request.hostFacts.hostname ?? null }
	});
	return claimResponseSchema.parse({
		nodeId,
		linkUrl: `${linkOrigin}/link/${nodeId}`,
		dashboardPublicKey
	});
}

// #endregion

// #region the view

export function toNodeView(record: NodeRecord): NodeView {
	const facts = record.hostFacts;
	const iso = (at: number) => new Date(at).toISOString();
	return {
		id: record.id,
		state: record.state,
		name: facts.hostname ?? `Node ${record.id.slice(-6)}`,
		os: facts.os ?? '',
		arch: facts.arch ?? '',
		bastionVersion: facts.bastionVersion ?? '',
		workerdVersion: facts.workerdVersion ?? '',
		mode: facts.mode ?? '',
		pairedAt: iso(record.pairedAt),
		lastSeenAt: record.lastSeenAt === null ? null : iso(record.lastSeenAt),
		revokedAt: record.revokedAt === null ? null : iso(record.revokedAt)
	};
}

// #endregion

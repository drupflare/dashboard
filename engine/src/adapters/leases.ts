import type { AcquireRequest, Granted, HolderRequest, Refused } from '../lease';
import type { Leases } from '../ports';

export interface LeaseStub {
	acquire(request: Omit<AcquireRequest, 'now'>): Promise<Granted | Refused>;
	heartbeat(request: Omit<HolderRequest, 'now'> & { ttlMs: number }): Promise<Granted | Refused>;
	release(request: Omit<HolderRequest, 'now'>): Promise<{ ok: true } | Refused>;
	check(request: Omit<HolderRequest, 'now'>): Promise<Granted | Refused>;
}

export function leasesOf(lease: (siteId: string) => LeaseStub): Leases {
	return {
		acquire: (siteId, request) => lease(siteId).acquire(request),
		heartbeat: (siteId, request) => lease(siteId).heartbeat(request),
		release: (siteId, request) => lease(siteId).release(request),
		check: (siteId, request) => lease(siteId).check(request)
	};
}

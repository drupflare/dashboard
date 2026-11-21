// a copy of `contracts/src/owner-routes.ts`, pinned to it by a test; the worker's `OWNER_ROUTES`
// is the source
export const OWNER_ROUTES: ReadonlySet<string> = new Set([
	'/export',
	'/health',
	'/serve-stats',
	'/setup/cf',
	'/setup/mail',
	'/setup/oidc',
	'/git',
	'/installable',
	'/install',
	'/install-lock',
	'/enable',
	'/armfill',
	'/invalidate',
	'/bump',
	'/migrate',
	'/recycle',
	'/ledger-gc',
	'/strata-config',
	'/strata-store',
	'/updb',
	'/mirror',
	'/ops',
	'/pitr',
	'/restore',
	'/restore-parts',
	'/offloaded',
	'/writemark',
	'/writechanges',
	'/reconcile',
	'/sweep',
	'/queue',
	'/modify',
	'/settings',
	'/audit',
	'/deployment',
	'/retire',
	'/_cfw',
	'/_cfw/extend',
	'/_cfw/commands',
	'/_cfw/operate',
	'/_cfw/deploy',
	'/_cfw/git',
	'/_cfw/access'
]);

// the worker matches the path exactly, so `/export/` is a page and gets no pass
export function isOwnerRequest(request: Request): boolean {
	const authorization = request.headers.get('authorization');
	if (authorization === null || !/^Bearer\s+\S/i.test(authorization)) return false;
	return OWNER_ROUTES.has(new URL(request.url).pathname);
}

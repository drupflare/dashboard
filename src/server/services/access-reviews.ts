import type { CollegeDBClient } from '@earth-app/collegedb';
import {
	DAY_MS,
	REVIEW_DUE_DAYS,
	STALE_DAYS,
	type CloseResult,
	type EvidenceJson,
	type ReviewCreateBody,
	type ReviewDecideBody,
	type ReviewDetail,
	type ReviewInterval,
	type ReviewItemView,
	type ReviewScheduleView,
	type ReviewView,
	type StaleReport
} from '../../shared/access-reviews';
import { ApiError } from '../../shared/errors';
import { serviceAccountStateOf } from '../../shared/service-accounts';
import {
	accountKeyLinks,
	closeReviewRow,
	decideReviewItem,
	getReview,
	getReviewItem,
	getSchedule,
	getServiceAccount,
	insertReview,
	insertReviewItem,
	listAccountKeys,
	listActiveSchedules,
	listDepartmentRoles,
	listLiveKeys,
	listLiveSiteGrants,
	listOpenDelegations,
	listReviewItems,
	listReviewRows,
	listServiceAccounts,
	markItemApplied,
	putSchedule,
	touchSchedule,
	type ItemRow,
	type ReviewRow
} from '../db/repos/access-governance';
import {
	getDepartment,
	getSiteDepartment,
	listDepartments,
	removeDepartmentMember
} from '../db/repos/departments';
import { getUserById } from '../db/repos/identity';
import {
	getDelegation,
	getOrganization,
	getSiteGrant,
	listMembers,
	revokeApiKey
} from '../db/repos/organization';
import {
	canDecide,
	countDecisions,
	decideStanding,
	evidenceCsv,
	holdsRight,
	reviewDue,
	reviewReach,
	staleReport,
	type ReviewViewer
} from '../domain/access-review';
import { descendants } from '../domain/departments';
import { sha256Hex } from './crypto';
import { revokeDelegationBatchFor } from './delegations';
import { iso, type GovernanceActor, type GovernanceServices } from './governance';
import { removeOrgMember } from './members';
import { departmentAdminsDecideReviews } from './org-settings';
import { principalActor } from './owner-tokens';
import { disableAccountOf } from './service-accounts';
import { revokeGrant } from './site-grants';

const SYSTEM = 'system:schedule';
const WHOLE = 'organization';

// #region snapshot

type Draft = Omit<
	ItemRow,
	| 'organizationId'
	| 'reviewId'
	| 'decision'
	| 'decidedBy'
	| 'decidedAt'
	| 'reason'
	| 'appliedAt'
	| 'applyError'
>;

function names(db: CollegeDBClient) {
	const seen = new Map<string, string>();
	return async (userId: string): Promise<string> => {
		const known = seen.get(userId);
		if (known !== undefined) return known;
		const user = await getUserById(db, userId);
		const label = user?.email ?? userId;
		seen.set(userId, label);
		return label;
	};
}

const day = (at: number | null) =>
	at === null ? 'never' : new Date(at).toISOString().slice(0, 10);

async function subtreeOf(db: CollegeDBClient, orgId: string, departmentId: string) {
	const rows = await listDepartments(db, orgId);
	const tree = rows.map((row) => ({ id: row.id, parentId: row.parentId, kind: row.kind }));
	return [departmentId, ...descendants(tree, departmentId)];
}

// every subject in scope, as it stands now; later changes to the live data never touch the copy
export async function snapshotSubjects(
	db: CollegeDBClient,
	orgId: string,
	scope: string,
	now: number
): Promise<Draft[]> {
	const who = names(db);
	const out: Draft[] = [];
	const wholeOrg = scope === WHOLE;
	const departments = wholeOrg ? undefined : await subtreeOf(db, orgId, scope);

	if (wholeOrg) {
		let after: string | undefined;
		for (;;) {
			const page = await listMembers(db, orgId, { after, limit: 100 });
			for (const member of page.items) {
				out.push({
					kind: 'member',
					subjectRef: member.id,
					subjectUserId: member.userId,
					label: await who(member.userId),
					detail: `Role: ${member.role}. Joined ${day(member.createdAt)}`,
					departmentId: null
				});
			}
			if (page.nextCursor === null) break;
			after = page.nextCursor;
		}
	}

	for (const role of await listDepartmentRoles(
		db,
		orgId,
		departments ? { departmentIds: departments } : {}
	)) {
		out.push({
			kind: 'grant',
			subjectRef: `department:${role.departmentId}:${role.userId}`,
			subjectUserId: role.userId,
			label: `${await who(role.userId)} in ${role.departmentName}`,
			detail: `Department role: ${role.role}. Since ${day(role.grantedAt)}`,
			departmentId: role.departmentId
		});
	}
	for (const grant of await listLiveSiteGrants(db, orgId, now, departments)) {
		out.push({
			kind: 'grant',
			subjectRef: grant.id,
			subjectUserId: grant.userId,
			label: `${await who(grant.userId)} on ${grant.siteName}`,
			detail: `Site role: ${grant.role}. Since ${day(grant.createdAt)}`,
			departmentId: grant.departmentId
		});
	}

	if (wholeOrg) {
		for (const row of await listOpenDelegations(db, orgId)) {
			const agency = await getOrganization(db, row.agencyOrganizationId);
			out.push({
				kind: 'delegation',
				subjectRef: row.id,
				subjectUserId: row.createdBy,
				label: `Agency access for ${agency?.name ?? row.agencyOrganizationId}`,
				detail: `Role: ${row.role}. ${row.siteId === null ? 'Every site' : 'One site'}. ${row.state}`,
				departmentId:
					row.siteId === null
						? null
						: ((await getSiteDepartment(db, orgId, row.siteId))?.departmentId ?? null)
			});
		}
		const links = await accountKeyLinks(db, orgId);
		for (const key of await listLiveKeys(db, orgId, now)) {
			// a service account's keys are reviewed with the account
			if (links.has(key.id)) continue;
			out.push({
				kind: 'api-key',
				subjectRef: key.id,
				subjectUserId: key.createdBy,
				label: key.name,
				detail: `Made by ${await who(key.createdBy)}. Last used ${day(key.lastUsedAt)}`,
				departmentId: null
			});
		}
	}

	for (const account of await listServiceAccounts(db, orgId)) {
		if (serviceAccountStateOf(account, now) !== 'active') continue;
		if (departments !== undefined && !departments.includes(account.departmentId ?? ''))
			continue;
		out.push({
			kind: 'service-account',
			subjectRef: account.id,
			subjectUserId: account.ownerUserId,
			label: account.name,
			detail: `Owner: ${await who(account.ownerUserId)}. Expires ${day(account.expiresAt)}`,
			departmentId: account.departmentId
		});
	}
	return out;
}

// #endregion

// #region views

async function scopeName(db: CollegeDBClient, orgId: string, scope: string): Promise<string> {
	if (scope === WHOLE) return 'The whole organization';
	return (await getDepartment(db, orgId, scope))?.name ?? 'A department that was removed';
}

async function reviewView(
	db: CollegeDBClient,
	row: ReviewRow,
	items?: readonly ItemRow[]
): Promise<ReviewView> {
	const rows = items ?? (await listReviewItems(db, row.organizationId, row.id));
	return {
		id: row.id,
		scope: row.scope,
		scopeName: await scopeName(db, row.organizationId, row.scope),
		state: row.state,
		dueAt: new Date(row.dueAt).toISOString(),
		createdBy: row.createdBy,
		createdAt: new Date(row.createdAt).toISOString(),
		closedAt: iso(row.closedAt),
		...countDecisions(rows)
	};
}

async function itemViews(
	db: CollegeDBClient,
	rows: readonly ItemRow[],
	viewerId: string | null
): Promise<ReviewItemView[]> {
	const who = names(db);
	return Promise.all(
		rows.map(async (row) => ({
			kind: row.kind,
			subjectRef: row.subjectRef,
			label: row.label,
			detail: row.detail,
			heldBy: row.subjectUserId === null ? null : await who(row.subjectUserId),
			decision: row.decision,
			decidedBy:
				row.decidedBy === null
					? null
					: row.decidedBy.startsWith('user:')
						? await who(row.decidedBy.slice(5))
						: row.decidedBy,
			decidedAt: iso(row.decidedAt),
			reason: row.reason,
			appliedAt: iso(row.appliedAt),
			applyError: row.applyError,
			own: viewerId !== null && row.subjectUserId === viewerId
		}))
	);
}

async function load(db: CollegeDBClient, orgId: string, id: string): Promise<ReviewRow> {
	const row = await getReview(db, orgId, id);
	if (row === null) throw new ApiError('not_found', 'Not found');
	return row;
}

interface Reach {
	limited: boolean;
	covers: (item: { departmentId: string | null }) => boolean;
}

const EVERYTHING: Reach = { limited: false, covers: () => true };

// owners and admins reach every item; a department admin reaches only the items inside their own
// departments, and none while the organization setting is off
async function reachOf(db: CollegeDBClient, orgId: string, viewer: ReviewViewer): Promise<Reach> {
	const reach = reviewReach(viewer, orgId);
	if (reach === 'none') {
		throw new ApiError(
			'forbidden',
			'Owners, admins and department admins can see access reviews'
		);
	}
	if (reach === 'whole') return EVERYTHING;
	const on = await departmentAdminsDecideReviews(db, orgId);
	const seen = new Map<string | null, boolean>();
	return {
		limited: true,
		covers: ({ departmentId }) => {
			let yes = seen.get(departmentId);
			if (yes === undefined) {
				yes = decideStanding(viewer, orgId, departmentId, on) === 'yes';
				seen.set(departmentId, yes);
			}
			return yes;
		}
	};
}

// without a viewer the list is unfiltered, for callers that already hold the whole-organization right
export async function listReviews(
	deps: GovernanceServices,
	orgId: string,
	viewer?: ReviewViewer
): Promise<ReviewView[]> {
	const db = await deps.getDb();
	const reach = viewer ? await reachOf(db, orgId, viewer) : EVERYTHING;
	const views: ReviewView[] = [];
	for (const row of await listReviewRows(db, orgId)) {
		if (!reach.limited) {
			views.push(await reviewView(db, row));
			continue;
		}
		const items = (await listReviewItems(db, orgId, row.id)).filter(reach.covers);
		if (items.length > 0) views.push(await reviewView(db, row, items));
	}
	return views;
}

export async function reviewDetail(
	deps: GovernanceServices,
	orgId: string,
	viewerId: string,
	id: string,
	viewer?: ReviewViewer
): Promise<ReviewDetail> {
	const db = await deps.getDb();
	const reach = viewer ? await reachOf(db, orgId, viewer) : EVERYTHING;
	const row = await load(db, orgId, id);
	const items = (await listReviewItems(db, orgId, id)).filter(reach.covers);
	if (reach.limited && items.length === 0) throw new ApiError('not_found', 'Not found');
	return {
		...(await reviewView(db, row, items)),
		items: await itemViews(db, items, viewerId),
		limited: reach.limited
	};
}

// #endregion

// #region open

export async function openReview(
	deps: GovernanceServices,
	orgId: string,
	createdBy: string,
	input: { scope: string; dueInDays?: number }
): Promise<ReviewView> {
	const db = await deps.getDb();
	if (input.scope !== WHOLE && (await getDepartment(db, orgId, input.scope)) === null) {
		throw new ApiError('validation', 'That department does not exist in this organization');
	}
	const now = deps.now();
	const id = deps.newId();
	const subjects = await snapshotSubjects(db, orgId, input.scope, now);
	for (const subject of subjects) {
		await insertReviewItem(db, {
			...subject,
			organizationId: orgId,
			reviewId: id,
			decision: 'pending',
			decidedBy: null,
			decidedAt: null,
			reason: null,
			appliedAt: null,
			applyError: null
		});
	}
	// the review row goes in last, so a failure above leaves items nobody can see
	const row: ReviewRow = {
		id,
		organizationId: orgId,
		scope: input.scope,
		state: 'open',
		dueAt: now + (input.dueInDays ?? REVIEW_DUE_DAYS) * DAY_MS,
		createdBy,
		createdAt: now,
		closedAt: null
	};
	await insertReview(db, row);
	await deps.audit(orgId, {
		actor: createdBy,
		action: 'access-review.opened',
		target: id,
		detail: { scope: input.scope, items: subjects.length }
	});
	return reviewView(db, row);
}

export function createReview(
	deps: GovernanceServices,
	orgId: string,
	actor: GovernanceActor,
	body: ReviewCreateBody
): Promise<ReviewView> {
	return openReview(deps, orgId, principalActor(actor.principal), body);
}

// #endregion

// #region decide and apply

const message = (error: unknown) =>
	error instanceof Error ? error.message : 'The removal did not go through';

// the real revocation, through the same services the rest of the dashboard uses
async function revoke(
	deps: GovernanceServices,
	orgId: string,
	actor: GovernanceActor,
	item: ItemRow
): Promise<void> {
	const db = await deps.getDb();
	const by = principalActor(actor.principal);
	switch (item.kind) {
		case 'member': {
			const role = actor.facts.membership?.role;
			if (role === undefined)
				throw new ApiError('forbidden', 'Your role does not reach that member');
			await removeOrgMember(
				{ ...deps, inviteMail: async () => undefined, baseUrl: '' },
				orgId,
				{ principal: actor.principal, role, userId: actor.userId },
				item.subjectRef
			);
			return;
		}
		case 'grant': {
			if (item.subjectRef.startsWith('department:')) {
				const [, departmentId, userId] = item.subjectRef.split(':');
				if (await removeDepartmentMember(db, orgId, departmentId!, userId!)) {
					await deps.audit(orgId, {
						actor: by,
						action: 'department.member.removed',
						target: `${departmentId}:${userId}`,
						detail: { via: 'access-review' }
					});
				}
				return;
			}
			const grant = await getSiteGrant(db, orgId, item.subjectRef);
			if (grant === null) return;
			await revokeGrant(deps, orgId, grant.siteId, actor, grant.id);
			return;
		}
		case 'delegation': {
			const row = await getDelegation(db, orgId, item.subjectRef);
			if (row === null) return;
			await revokeDelegationBatchFor(deps, orgId, actor, row.batchId);
			return;
		}
		case 'api-key': {
			if (await revokeApiKey(db, orgId, item.subjectRef, deps.now())) {
				await deps.audit(orgId, {
					actor: by,
					action: 'key.revoked',
					target: item.subjectRef,
					detail: { via: 'access-review' }
				});
			}
			return;
		}
		case 'service-account': {
			const account = await getServiceAccount(db, orgId, item.subjectRef);
			if (account === null || account.disabledAt !== null) return;
			await disableAccountOf(deps, orgId, account, by);
			return;
		}
	}
}

async function apply(
	deps: GovernanceServices,
	orgId: string,
	actor: GovernanceActor,
	item: ItemRow
): Promise<boolean> {
	const db = await deps.getDb();
	try {
		await revoke(deps, orgId, actor, item);
		await markItemApplied(db, item, { appliedAt: deps.now(), error: null });
		return true;
	} catch (error) {
		await markItemApplied(db, item, { appliedAt: null, error: message(error) });
		return false;
	}
}

export async function decideItem(
	deps: GovernanceServices,
	orgId: string,
	actor: GovernanceActor,
	reviewId: string,
	body: ReviewDecideBody
): Promise<ReviewItemView> {
	const db = await deps.getDb();
	const review = await load(db, orgId, reviewId);
	const item = await getReviewItem(db, orgId, reviewId, body.kind, body.subjectRef);
	if (item === null) throw new ApiError('not_found', 'Not found');
	// a department admin gets the same answer for an item outside their reach as for a missing one
	const standing = decideStanding(
		actor,
		orgId,
		item.departmentId,
		await departmentAdminsDecideReviews(db, orgId)
	);
	if (standing === 'no') throw new ApiError('not_found', 'Not found');
	if (standing === 'off') {
		throw new ApiError(
			'forbidden',
			'Department admins cannot decide review items in this organization. Ask an owner or admin',
			{ reason: 'department_decisions_off' }
		);
	}
	if (review.state !== 'open') {
		throw new ApiError('conflict', 'This review is closed', { reason: 'review_closed' });
	}
	if (body.applyNow === true && !holdsRight(actor, orgId, 'review.manage')) {
		throw new ApiError(
			'forbidden',
			'Only an owner or admin can carry out a removal. Choose Remove, and it is carried out when the review closes',
			{ reason: 'apply_needs_admin' }
		);
	}
	if (!canDecide(actor.userId, item.subjectUserId)) {
		throw new ApiError(
			'forbidden',
			'This one is about you. Ask another owner or admin to decide it',
			{ reason: 'own_item' }
		);
	}
	const changed = await decideReviewItem(db, item, {
		decision: body.decision,
		decidedBy: principalActor(actor.principal),
		decidedAt: deps.now(),
		reason: body.reason?.trim() || null
	});
	if (!changed) {
		throw new ApiError('conflict', 'This item was already acted on', { reason: 'applied' });
	}
	await deps.audit(orgId, {
		actor: principalActor(actor.principal),
		action: 'access-review.decided',
		target: reviewId,
		detail: { kind: item.kind, subject: item.subjectRef, decision: body.decision }
	});
	if (body.decision === 'revoke' && body.applyNow === true) {
		await apply(
			deps,
			orgId,
			actor,
			(await getReviewItem(db, orgId, reviewId, item.kind, item.subjectRef))!
		);
	}
	const fresh = await getReviewItem(db, orgId, reviewId, item.kind, item.subjectRef);
	return (await itemViews(db, [fresh!], actor.userId))[0]!;
}

// closing applies every removal that is still waiting; a failure is kept on the item and the
// review still closes, so the record shows what did not happen
export async function closeReview(
	deps: GovernanceServices,
	orgId: string,
	actor: GovernanceActor,
	reviewId: string
): Promise<CloseResult> {
	const db = await deps.getDb();
	const review = await load(db, orgId, reviewId);
	if (review.state !== 'open') {
		throw new ApiError('conflict', 'This review is already closed', {
			reason: 'review_closed'
		});
	}
	const items = await listReviewItems(db, orgId, reviewId);
	const waiting = items.filter((item) => item.decision === 'pending').length;
	if (waiting > 0) {
		throw new ApiError(
			'conflict',
			`${waiting} ${waiting === 1 ? 'item is' : 'items are'} still waiting for a decision`,
			{ reason: 'pending_items', waiting }
		);
	}
	let applied = 0;
	let failed = 0;
	for (const item of items) {
		if (item.decision !== 'revoke' || item.appliedAt !== null) continue;
		if (await apply(deps, orgId, actor, item)) applied += 1;
		else failed += 1;
	}
	await closeReviewRow(db, orgId, reviewId, deps.now());
	await deps.audit(orgId, {
		actor: principalActor(actor.principal),
		action: 'access-review.closed',
		target: reviewId,
		detail: { applied, failed }
	});
	return { review: await reviewView(db, await load(db, orgId, reviewId)), applied, failed };
}

// #endregion

// #region evidence, stale report, schedule

export async function reviewEvidence(
	deps: GovernanceServices,
	orgId: string,
	reviewId: string
): Promise<{ json: EvidenceJson; csv: string }> {
	const db = await deps.getDb();
	const review = await load(db, orgId, reviewId);
	if (review.state !== 'closed') {
		throw new ApiError('conflict', 'Close the review before you export it', {
			reason: 'review_open'
		});
	}
	const rows = await listReviewItems(db, orgId, reviewId);
	const items = await itemViews(db, rows, null);
	const csv = evidenceCsv(items);
	return {
		csv,
		json: { review: await reviewView(db, review, rows), items, sha256: await sha256Hex(csv) }
	};
}

export async function staleCredentials(
	deps: GovernanceServices,
	orgId: string,
	days: number = STALE_DAYS
): Promise<StaleReport> {
	const db = await deps.getDb();
	const now = deps.now();
	const who = names(db);
	const links = await accountKeyLinks(db, orgId);
	const inputs: Parameters<typeof staleReport>[0][number][] = [];
	for (const key of await listLiveKeys(db, orgId, now)) {
		if (links.has(key.id)) continue;
		inputs.push({
			kind: 'api-key',
			subjectRef: key.id,
			label: `${key.name} (made by ${await who(key.createdBy)})`,
			lastUsedAt: key.lastUsedAt,
			since: key.createdAt
		});
	}
	for (const account of await listServiceAccounts(db, orgId)) {
		if (serviceAccountStateOf(account, now) !== 'active') continue;
		const keys = await listAccountKeys(db, orgId, account.id);
		const last = keys.reduce<number | null>(
			(best, key) =>
				key.lastUsedAt !== null && (best === null || key.lastUsedAt > best)
					? key.lastUsedAt
					: best,
			null
		);
		inputs.push({
			kind: 'service-account',
			subjectRef: account.id,
			label: account.name,
			lastUsedAt: last,
			since: account.createdAt
		});
	}
	// a grant keeps no use mark, so its age is all that can be said
	for (const grant of await listLiveSiteGrants(db, orgId, now)) {
		inputs.push({
			kind: 'grant',
			subjectRef: grant.id,
			label: `${await who(grant.userId)} on ${grant.siteName}`,
			lastUsedAt: null,
			since: grant.createdAt
		});
	}
	return { days, items: staleReport(inputs, now, days) };
}

export async function getReviewSchedule(
	deps: GovernanceServices,
	orgId: string
): Promise<ReviewScheduleView> {
	const row = await getSchedule(await deps.getDb(), orgId);
	return { interval: row?.interval ?? 'off', lastOpenedAt: iso(row?.lastOpenedAt ?? null) };
}

export async function setReviewSchedule(
	deps: GovernanceServices,
	orgId: string,
	actor: GovernanceActor,
	interval: ReviewInterval
): Promise<ReviewScheduleView> {
	const db = await deps.getDb();
	await putSchedule(db, orgId, {
		interval,
		setBy: principalActor(actor.principal),
		at: deps.now()
	});
	await deps.audit(orgId, {
		actor: principalActor(actor.principal),
		action: 'access-review.schedule',
		target: orgId,
		detail: { interval }
	});
	return getReviewSchedule(deps, orgId);
}

export interface ScheduledRun {
	opened: string[];
	mailed: number;
	skipped: number;
	failed: string[];
}

// opens a review for every organisation whose interval has run out; one still open is not doubled
export async function runScheduledReviews(deps: GovernanceServices): Promise<ScheduledRun> {
	const db = await deps.getDb();
	const now = deps.now();
	const run: ScheduledRun = { opened: [], mailed: 0, skipped: 0, failed: [] };
	for (const schedule of await listActiveSchedules(db)) {
		if (!reviewDue(schedule, now)) continue;
		const orgId = schedule.organizationId;
		try {
			const open = (await listReviewRows(db, orgId)).some(
				(row) => row.state === 'open' && row.scope === WHOLE
			);
			if (open) continue;
			const review = await openReview(deps, orgId, SYSTEM, { scope: WHOLE });
			await touchSchedule(db, orgId, now);
			run.opened.push(review.id);
			const org = await getOrganization(db, orgId);
			const result = await deps.reviewMail(orgId, {
				orgName: org?.name ?? 'your organization',
				scopeName: review.scopeName,
				dueAt: review.dueAt,
				reviewUrl: `/org/reviews/${encodeURIComponent(review.id)}`
			});
			run.mailed += result.sent;
			run.skipped += result.skipped;
		} catch {
			run.failed.push(orgId);
		}
	}
	return run;
}

// #endregion

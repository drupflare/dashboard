import {
	DAY_MS,
	EVIDENCE_COLUMNS,
	REVIEW_INTERVAL_DAYS,
	STALE_DAYS,
	type ReviewDecision,
	type ReviewInterval,
	type ReviewItemView,
	type StaleRow
} from '../../shared/access-reviews';
import { SERVICE_ACCOUNT_MAX_MS } from '../../shared/service-accounts';
import { authorize, type Facts, type Principal } from './authorize';
import { csvLines } from './csv';
import { grantProvides } from './policy';

export type ExpiryError = 'past' | 'too_far';

// a service account always expires, and never more than the maximum from now
export function checkExpiry(expiresAt: number, now: number): ExpiryError | null {
	if (!Number.isFinite(expiresAt) || expiresAt <= now) return 'past';
	if (expiresAt > now + SERVICE_ACCOUNT_MAX_MS) return 'too_far';
	return null;
}

// nobody decides an item about themselves
export function canDecide(actorUserId: string, subjectUserId: string | null): boolean {
	return subjectUserId === null || subjectUserId !== actorUserId;
}

export interface ReviewViewer {
	principal: Principal;
	facts: Facts;
}

// an organization-level right such as review.manage, which no department role carries
export function holdsRight(
	viewer: ReviewViewer,
	orgId: string,
	action: 'review.read' | 'review.manage'
): boolean {
	return authorize({
		principal: viewer.principal,
		action,
		resource: { orgId },
		facts: viewer.facts
	}).allow;
}

export type DecideStanding = 'yes' | 'off' | 'no';

// owners and admins decide anywhere; a department admin decides only inside their own department
// subtree, and only while the organization setting is on. An item with no department is
// organization level, so no department admin reaches it.
export function decideStanding(
	viewer: ReviewViewer,
	orgId: string,
	departmentId: string | null,
	departmentAdminsOn: boolean
): DecideStanding {
	const decision = authorize({
		principal: viewer.principal,
		action: 'review.decide',
		resource: { orgId, ...(departmentId === null ? {} : { departmentId }) },
		facts: viewer.facts
	});
	if (!decision.allow) return 'no';
	if (decision.via !== 'department') return 'yes';
	return departmentAdminsOn ? 'yes' : 'off';
}

export type ReviewReach = 'whole' | 'department' | 'none';

// whole: owners and admins see every item. department: someone holds a department role that
// carries the decision, so the items are filtered. none: nothing to see.
export function reviewReach(viewer: ReviewViewer, orgId: string): ReviewReach {
	const whole = authorize({
		principal: viewer.principal,
		action: 'review.read',
		resource: { orgId },
		facts: viewer.facts
	});
	if (whole.allow) return 'whole';
	const holdsDepartmentRole = viewer.facts.grants.some(
		(grant) =>
			grant.level === 'department' &&
			grant.orgId === orgId &&
			grantProvides(grant, 'review.decide')
	);
	return holdsDepartmentRole ? 'department' : 'none';
}

export function reviewDue(
	schedule: { interval: ReviewInterval; lastOpenedAt: number | null },
	now: number
): boolean {
	const days = REVIEW_INTERVAL_DAYS[schedule.interval];
	if (days === null || schedule.lastOpenedAt === null) return false;
	return now - schedule.lastOpenedAt >= days * DAY_MS;
}

export function countDecisions(items: readonly { decision: ReviewDecision }[]) {
	const counts = { total: items.length, pending: 0, keep: 0, revoke: 0 };
	for (const item of items) counts[item.decision] += 1;
	return counts;
}

export interface StaleInput {
	kind: StaleRow['kind'];
	subjectRef: string;
	label: string;
	// null: no use recorded
	lastUsedAt: number | null;
	// when the credential came into being, the clock for one never used
	since: number;
}

// a credential is stale when its last use, or its start when never used, is at least `days` old
export function staleReport(
	inputs: readonly StaleInput[],
	now: number,
	days: number = STALE_DAYS
): StaleRow[] {
	const rows: StaleRow[] = [];
	for (const input of inputs) {
		const mark = input.lastUsedAt ?? input.since;
		const age = Math.floor((now - mark) / DAY_MS);
		if (age < days) continue;
		rows.push({
			kind: input.kind,
			subjectRef: input.subjectRef,
			label: input.label,
			lastUsedAt: input.lastUsedAt === null ? null : new Date(input.lastUsedAt).toISOString(),
			since: new Date(input.since).toISOString(),
			days: age
		});
	}
	return rows.sort((a, b) => b.days - a.days || a.label.localeCompare(b.label));
}

const KIND_NAME: Record<ReviewItemView['kind'], string> = {
	member: 'member',
	grant: 'grant',
	delegation: 'delegation',
	'api-key': 'api key',
	'service-account': 'service account'
};

// one row a decision, with the formula escape every cell gets from csvLines
export function evidenceCsv(items: readonly ReviewItemView[]): string {
	return csvLines([
		[...EVIDENCE_COLUMNS],
		...items.map((item) => [
			KIND_NAME[item.kind],
			item.label,
			item.heldBy,
			item.detail,
			item.decision,
			item.decidedBy,
			item.decidedAt,
			item.reason,
			item.appliedAt,
			item.applyError
		])
	]);
}

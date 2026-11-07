import { DateTime } from 'luxon';
import { DuplicateRowError } from '../../../../src/server/db/collegedb';
import type { User } from '../../../../src/server/db/repos/identity';
import type { Member, Organization } from '../../../../src/server/db/repos/organization';
import type { AuditInput } from '../../../../src/server/services/audit';
import type { AuthDeps, Directory } from '../../../../src/server/services/auth';
import type {
	AttemptStore,
	MailSender,
	MailTemplate
} from '../../../../src/server/services/email-codes';
import type { KvStore } from '../../../../src/server/services/sessions';
import type { OnceStore } from '../../../../src/server/services/single-use';
import { nowUtc, setClock } from '../../../../src/shared/utils/time';

export const T0 = 1_800_000_000_000;

// a movable clock behind nowutc; call stop in aftereach
export function useClock(start = T0) {
	let now = start;
	setClock(() => DateTime.fromMillis(now, { zone: 'utc' }));
	return {
		get now() {
			return now;
		},
		advance(ms: number) {
			now += ms;
		},
		stop() {
			setClock(null);
		}
	};
}

const tick = () => Promise.resolve();

export interface MemoryKv extends KvStore {
	dump(): Record<string, string>;
	keys(): string[];
	puts: { key: string; ttl: number | undefined }[];
}

// honours the ttl against the test clock and yields on every call so parallel callers interleave
export function memoryKv(): MemoryKv {
	const data = new Map<string, { value: string; expiresAt: number | null }>();
	const puts: MemoryKv['puts'] = [];
	const live = () => {
		const now = nowUtc().toMillis();
		for (const [key, entry] of data) {
			if (entry.expiresAt !== null && entry.expiresAt <= now) data.delete(key);
		}
	};
	return {
		puts,
		async get(key) {
			await tick();
			live();
			return data.get(key)?.value ?? null;
		},
		async put(key, value, options) {
			await tick();
			puts.push({ key, ttl: options?.expirationTtl });
			const ttl = options?.expirationTtl;
			data.set(key, {
				value,
				expiresAt: ttl === undefined ? null : nowUtc().toMillis() + ttl * 1000
			});
		},
		async delete(key) {
			await tick();
			data.delete(key);
		},
		async list({ prefix }) {
			await tick();
			live();
			return {
				keys: [...data.keys()]
					.filter((key) => key.startsWith(prefix))
					.sort()
					.map((name) => ({ name }))
			};
		},
		dump() {
			live();
			return Object.fromEntries([...data].map(([key, entry]) => [key, entry.value]));
		},
		keys() {
			live();
			return [...data.keys()];
		}
	};
}

export interface MemoryOnce extends OnceStore {
	dump(): Record<string, string>;
	keys(): string[];
	puts: { key: string; expiresAt: number }[];
}

// take and takeIf read and delete in one synchronous step, as the d1 statement does
export function memoryOnce(): MemoryOnce {
	const rows = new Map<string, { value: string; expiresAt: number }>();
	const puts: MemoryOnce['puts'] = [];
	const liveRows = () => {
		const now = nowUtc().toMillis();
		return [...rows].filter(([, row]) => row.expiresAt > now);
	};
	return {
		puts,
		async put(key, value, expiresAt) {
			await tick();
			puts.push({ key, expiresAt });
			rows.set(key, { value, expiresAt });
		},
		async get(key, now) {
			await tick();
			const row = rows.get(key);
			return row && row.expiresAt > now ? row.value : null;
		},
		async take(key, now) {
			await tick();
			const row = rows.get(key);
			rows.delete(key);
			return row && row.expiresAt > now ? row.value : null;
		},
		async takeIf(key, value, now) {
			await tick();
			const row = rows.get(key);
			if (!row || row.expiresAt <= now || row.value !== value) return false;
			rows.delete(key);
			return true;
		},
		dump() {
			return Object.fromEntries(liveRows().map(([key, row]) => [key, row.value]));
		},
		keys() {
			return liveRows().map(([key]) => key);
		}
	};
}

export interface MemoryAttempts extends AttemptStore {
	granted: { key: string; attempts: number }[];
}

// check and count run in one synchronous step, as the d1 statement does
export function memoryAttempts(): MemoryAttempts {
	const rows = new Map<string, { attempts: number; windowStart: number }>();
	const granted: MemoryAttempts['granted'] = [];
	return {
		granted,
		async claim(key, now, rule) {
			await tick();
			const row = rows.get(key);
			if (!row || row.windowStart <= now - rule.windowMs) {
				rows.set(key, { attempts: 1, windowStart: now });
				granted.push({ key, attempts: 1 });
				return 1;
			}
			if (row.attempts >= rule.limit) return null;
			row.attempts += 1;
			granted.push({ key, attempts: row.attempts });
			return row.attempts;
		},
		async clear(key) {
			await tick();
			rows.delete(key);
		}
	};
}

export interface MemoryDirectory extends Directory {
	users: User[];
	orgs: Organization[];
	members: Member[];
	audits: { organizationId: string; input: AuditInput }[];
}

// the email column is unique and the check runs at insert time, as in d1
export function memoryDirectory(): MemoryDirectory {
	const users: User[] = [];
	const orgs: Organization[] = [];
	const members: Member[] = [];
	const audits: MemoryDirectory['audits'] = [];
	let counter = 0;
	return {
		users,
		orgs,
		members,
		audits,
		async findUserByEmail(email) {
			await tick();
			return users.find((user) => user.email === email.trim().toLowerCase()) ?? null;
		},
		async findUserById(id) {
			await tick();
			return users.find((user) => user.id === id) ?? null;
		},
		async createUser(email) {
			await tick();
			const normalized = email.trim().toLowerCase();
			if (users.some((user) => user.email === normalized)) {
				throw new DuplicateRowError('UNIQUE constraint failed: users.email');
			}
			const now = nowUtc().toMillis();
			const user: User = {
				id: `user-${++counter}`,
				email: normalized,
				displayName: null,
				platformRole: null,
				createdAt: now,
				updatedAt: now
			};
			users.push(user);
			return user;
		},
		async ensurePersonalOrganization(user) {
			await tick();
			const found = orgs.find((org) => org.personal && org.createdBy === user.id);
			if (found) return { org: found, created: false };
			const now = nowUtc().toMillis();
			const org: Organization = {
				id: `org-${++counter}`,
				name: 'Personal',
				personal: true,
				createdBy: user.id,
				createdAt: now,
				updatedAt: now
			};
			orgs.push(org);
			members.push({
				id: `member-${++counter}`,
				organizationId: org.id,
				userId: user.id,
				role: 'owner',
				createdAt: now,
				updatedAt: now
			});
			return { org, created: true };
		},
		async appendAudit(organizationId, input) {
			await tick();
			audits.push({ organizationId, input });
		}
	};
}

export interface MemoryMail extends MailSender {
	sent: { to: string; template: MailTemplate }[];
	lastCode(): string;
	failNext(): void;
}

export function memoryMail(): MemoryMail {
	const sent: MemoryMail['sent'] = [];
	let fail = false;
	return {
		sent,
		async send(to, template) {
			if (fail) {
				fail = false;
				throw new Error('mail is down');
			}
			sent.push({ to, template });
		},
		lastCode() {
			const last = sent.at(-1);
			if (!last) throw new Error('no mail was sent');
			return last.template.code;
		},
		failNext() {
			fail = true;
		}
	};
}

export const SECRET = 'test-code-secret';

export interface Harness extends AuthDeps {
	kv: MemoryKv;
	once: MemoryOnce;
	attempts: MemoryAttempts;
	directory: MemoryDirectory;
	mail: MemoryMail;
	turnstileCalls: { token: string | undefined; ip: string | undefined }[];
	passTurnstile: boolean;
}

// a full set of fake collaborators; set passturnstile false to make the bot check fail
export function harness(): Harness {
	const turnstileCalls: Harness['turnstileCalls'] = [];
	const h: Harness = {
		kv: memoryKv(),
		once: memoryOnce(),
		attempts: memoryAttempts(),
		directory: memoryDirectory(),
		mail: memoryMail(),
		codeSecret: SECRET,
		turnstileCalls,
		passTurnstile: true,
		turnstile: async (token, ip) => {
			turnstileCalls.push({ token, ip });
			return h.passTurnstile;
		}
	};
	return h;
}

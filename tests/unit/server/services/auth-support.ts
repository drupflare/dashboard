import { DateTime } from 'luxon';
import { DuplicateRowError } from '../../../../src/server/db/collegedb';
import type { User } from '../../../../src/server/db/repos/identity';
import type { Member, Organization } from '../../../../src/server/db/repos/organization';
import type { AuditInput } from '../../../../src/server/services/audit';
import type { AuthDeps, Directory } from '../../../../src/server/services/auth';
import type { MailSender, MailTemplate } from '../../../../src/server/services/email-codes';
import type { KvStore } from '../../../../src/server/services/sessions';
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
				createdAt: now,
				updatedAt: now
			};
			users.push(user);
			return user;
		},
		async createPersonalOrganization(user) {
			await tick();
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
			return org;
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

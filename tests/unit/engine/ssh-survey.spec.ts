import { describe, expect, it } from 'vitest';
import {
	createSshSurvey,
	type SshConnectOptions,
	type SshConnector,
	type SshSessionLike
} from '../../../engine/src/adapters/ssh-survey';
import type { SshTarget } from '../../../engine/src/ports';

const SERVER_KEY = new TextEncoder().encode('server-key');
const PEM = 'PEM-SECRET';

const target = (expectedFingerprint = 'SHA256:server-key'): SshTarget => ({
	host: 'host.example',
	port: 22,
	user: 'deploy',
	privateKey: PEM,
	expectedFingerprint,
	root: '/var/www/html'
});

const failureOf = async (promise: Promise<unknown>): Promise<Error> =>
	(await promise.then(
		() => new Error('expected a refusal'),
		(caught: unknown) => caught
	)) as Error;

const answer = (command: string): string | null => {
	if (command === 'php -v') return 'PHP 8.3.6 (cli) (built: Jan 1 2026)\n';
	if (command.includes('status --format=json')) {
		return JSON.stringify({
			'drupal-version': '11.4.8',
			'db-driver': 'mysql',
			'db-name': 'site',
			uri: 'http://site.example',
			root: '/var/www/html'
		});
	}
	if (command.includes('pm:list')) return '["node","system"]';
	return null;
};

interface Record {
	options: SshConnectOptions;
	commands: string[];
	closed: boolean;
}

function fakeConnector(failExec: string | null = null) {
	const sessions: Record[] = [];
	const connector: SshConnector = {
		resolve: async () => ['93.184.216.34'],
		async fingerprint(key) {
			return `SHA256:${new TextDecoder().decode(key)}`;
		},
		async connect(options) {
			const record: Record = { options, commands: [], closed: false };
			sessions.push(record);
			if (!(await options.hostKey.verify('ssh-ed25519', SERVER_KEY))) {
				throw new Error('host key rejected');
			}
			const session: SshSessionLike = {
				async exec(command) {
					record.commands.push(command);
					if (command === failExec) throw new Error('channel reset');
					const out = answer(command);
					return { code: out === null ? 1 : 0, stdoutText: out ?? '', stderrText: '' };
				},
				async close() {
					record.closed = true;
				}
			};
			return session;
		}
	};
	return { connector, sessions };
}

describe('createSshSurvey', () => {
	it('surveys over one session, closes it, and keeps the key out of the result', async () => {
		const { connector, sessions } = fakeConnector();

		const survey = await createSshSurvey(connector).run(target());

		expect(survey.php.version).toBe('8.3.6');
		expect(survey.drupal.version).toBe('11.4.8');
		expect(survey.database.driver).toBe('mysql');
		expect(survey.modules).toEqual(['node', 'system']);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]!.commands.length).toBeGreaterThan(0);
		expect(sessions[0]!.closed).toBe(true);
		expect(sessions[0]!.options).toMatchObject({
			hostname: '93.184.216.34',
			username: 'deploy',
			privateKey: { pem: PEM },
			timeoutMs: 15_000
		});
		expect(JSON.stringify(survey)).not.toContain(PEM);
	});

	it('refuses a host key that is not the confirmed one before any command runs', async () => {
		const { connector, sessions } = fakeConnector();

		const error = await failureOf(createSshSurvey(connector).run(target('SHA256:other')));

		expect(error).toMatchObject({ code: 'host_key_mismatch' });
		expect(error.message).not.toContain(PEM);
		expect(sessions[0]!.commands).toEqual([]);
	});

	it('reports an unreachable host with a plain refusal', async () => {
		const connector: SshConnector = {
			resolve: async () => ['93.184.216.34'],
			fingerprint: async () => 'SHA256:x',
			connect: async () => {
				throw new Error(`connect ECONNREFUSED ${PEM}`);
			}
		};

		const error = await failureOf(createSshSurvey(connector).run(target()));

		expect(error).toMatchObject({ code: 'source_unreachable' });
		expect(error.message).not.toContain(PEM);
	});

	it('records a failed command and still closes the session', async () => {
		const { connector, sessions } = fakeConnector('php -v');

		const survey = await createSshSurvey(connector).run(target());

		expect(survey.errors.map((error) => error.id)).toContain('php-version');
		expect(survey.drupal.version).toBe('11.4.8');
		expect(sessions[0]!.closed).toBe(true);
	});
});

describe('the address that is dialled', () => {
	const answering = (...lookups: string[][]) => {
		const { connector, sessions } = fakeConnector();
		let calls = 0;
		connector.resolve = async () => lookups[Math.min(calls++, lookups.length - 1)] ?? [];
		return { connector, sessions, calls: () => calls };
	};

	it('dials the address that passed and not the name', async () => {
		const { connector, sessions } = answering(['93.184.216.34']);
		await createSshSurvey(connector).run(target());
		expect(sessions[0]!.options.hostname).toBe('93.184.216.34');
	});

	it('refuses a name that was public on one survey and is private on the next, before it connects', async () => {
		const { connector, sessions } = answering(['93.184.216.34'], ['10.0.0.7']);
		const survey = createSshSurvey(connector);
		await survey.run(target());
		const error = await failureOf(survey.run(target()));
		expect(error).toMatchObject({ code: 'source_host_private' });
		expect(sessions).toHaveLength(1);
		expect(error.message).not.toContain(PEM);
	});

	it.each(['10.0.0.7', '127.0.0.1', '169.254.169.254', '::1'])(
		'refuses the private literal %s without a lookup or a connection',
		async (host) => {
			const { connector, sessions, calls } = answering(['93.184.216.34']);
			const error = await failureOf(createSshSurvey(connector).run({ ...target(), host }));
			expect(error).toMatchObject({ code: 'source_host_private' });
			expect(calls()).toBe(0);
			expect(sessions).toEqual([]);
		}
	);
});

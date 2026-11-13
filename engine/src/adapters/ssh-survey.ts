import type { Resolver } from '../../../src/server/integrations/url-guard';
import type { SshSurvey, SshTarget } from '../ports';
import { runSurvey, type SiteSurvey } from '../vendor/drangler/survey';
import { openSession, type SshConnectOptions } from './ssh-session';

export type { SshConnectOptions } from './ssh-session';

export interface SshCommandResult {
	code: number;
	stdoutText: string;
	stderrText: string;
}

export interface SshSessionLike {
	exec(command: string): Promise<SshCommandResult>;
	close(): Promise<void>;
}

// the edgeport binding, injected so the survey runs under test without a socket
export interface SshConnector {
	connect(options: SshConnectOptions): Promise<SshSessionLike>;
	fingerprint(key: Uint8Array): Promise<string>;
	resolve: Resolver;
}

export function createSshSurvey(
	connector: SshConnector,
	now: () => Date = () => new Date()
): SshSurvey {
	return {
		async run(target: SshTarget): Promise<SiteSurvey> {
			const session = await openSession(connector, target);
			try {
				return await runSurvey(
					{
						transport: {
							exec: async (command) => {
								const result = await session.exec(command);
								return {
									code: result.code,
									stdout: result.stdoutText,
									stderr: result.stderrText
								};
							}
						},
						now
					},
					target.host,
					target.root
				);
			} finally {
				await session.close();
			}
		}
	};
}

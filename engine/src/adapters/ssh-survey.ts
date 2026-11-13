import type { SshSurvey, SshTarget } from '../ports';
import { PermanentError } from '../step';
import { runSurvey, type SiteSurvey } from '../vendor/drangler/survey';

export interface SshCommandResult {
	code: number;
	stdoutText: string;
	stderrText: string;
}

export interface SshSessionLike {
	exec(command: string): Promise<SshCommandResult>;
	close(): Promise<void>;
}

export interface SshConnectOptions {
	hostname: string;
	port: number;
	username: string;
	privateKey: { pem: string };
	timeoutMs: number;
	// returns whether the server key is the one the owner confirmed
	hostKey: { verify(keyType: string, key: Uint8Array): Promise<boolean> };
}

// the edgeport binding, injected so the survey runs under test without a socket
export interface SshConnector {
	connect(options: SshConnectOptions): Promise<SshSessionLike>;
	fingerprint(key: Uint8Array): Promise<string>;
}

const CONNECT_TIMEOUT_MS = 15_000;

export function createSshSurvey(
	connector: SshConnector,
	now: () => Date = () => new Date()
): SshSurvey {
	return {
		async run(target: SshTarget): Promise<SiteSurvey> {
			// the fingerprint the server presented, kept so a refusal can say whether the key differed
			let presented: string | null = null;
			let session: SshSessionLike;
			try {
				session = await connector.connect({
					hostname: target.host,
					port: target.port,
					username: target.user,
					privateKey: { pem: target.privateKey },
					timeoutMs: CONNECT_TIMEOUT_MS,
					hostKey: {
						async verify(_keyType, key) {
							presented = await connector.fingerprint(key);
							return presented === target.expectedFingerprint;
						}
					}
				});
			} catch {
				if (presented !== null && presented !== target.expectedFingerprint) {
					throw new PermanentError(
						'host_key_mismatch',
						'the server host key is not the one confirmed, so nothing was run'
					);
				}
				throw new PermanentError(
					'source_unreachable',
					'the server did not accept the connection'
				);
			}
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

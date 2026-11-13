import { connect, fingerprint } from 'edgeport/ssh';
import { dohResolve } from '../../../src/server/integrations/url-guard';
import type { StreamConnector } from './dump-stream';
import type { SshConnector } from './ssh-survey';

export const edgeportConnector: SshConnector = {
	async connect(options) {
		const session = await connect(options);
		return {
			async exec(command) {
				const result = await session.exec(command);
				return {
					code: result.code,
					stdoutText: result.stdoutText,
					stderrText: result.stderrText
				};
			},
			close: () => session.close()
		};
	},
	fingerprint,
	resolve: (hostname) => dohResolve(hostname)
};

// aes-gcm over the pure-js chacha for a large transfer; the effect on step cpu time is unmeasured
export const edgeportStreamConnector: StreamConnector = {
	async connect(options) {
		const session = await connect({
			...options,
			algorithms: { cipher: ['aes256-gcm@openssh.com', 'aes128-gcm@openssh.com'] }
		});
		return {
			async stream(command) {
				const channel = await session.execStream(command);
				return { stdout: channel.stdout, stderr: channel.stderr, exit: channel.exit };
			},
			close: () => session.close()
		};
	},
	fingerprint,
	resolve: (hostname) => dohResolve(hostname)
};

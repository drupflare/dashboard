import { connect, fingerprint } from 'edgeport/ssh';
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
	fingerprint
};

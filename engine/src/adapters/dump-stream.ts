import type { Resolver } from '../../../src/server/integrations/url-guard';
import { ImportError, partKey } from '../import-parts';
import type { BackupBlobs, DumpJob, DumpStream, SshTarget } from '../ports';
import { openSession, type SshConnectOptions } from './ssh-session';

export interface StreamChannel {
	stdout: ReadableStream<Uint8Array>;
	// drained and never read, since a server's error text can carry anything
	stderr: ReadableStream<Uint8Array>;
	exit: Promise<{ code: number | null }>;
}

export interface StreamSessionLike {
	stream(command: string): Promise<StreamChannel>;
	close(): Promise<void>;
}

export interface StreamConnector {
	connect(options: SshConnectOptions): Promise<StreamSessionLike>;
	fingerprint(key: Uint8Array): Promise<string>;
	resolve: Resolver;
}

const shq = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// both commands only read: a dump to stdout and a tar to stdout, so nothing is written on the source
export function dumpCommand(kind: DumpJob['kind'], root: string): string {
	return kind === 'database'
		? `cd ${shq(root)} && drush sql:dump --extra-dump=--hex-blob`
		: `tar -C ${shq(`${root}/sites/default/files`)} -cf - .`;
}

export function createDumpStream(
	connector: StreamConnector,
	blobs: Pick<BackupBlobs, 'put' | 'deletePrefix'>
): DumpStream {
	return {
		async run(target: SshTarget, job: DumpJob, onPart) {
			const session = await openSession(connector, target);
			try {
				// a retry starts over, so the parts of an earlier attempt never mix with these
				await blobs.deletePrefix(job.prefix);
				const channel = await session.stream(dumpCommand(job.kind, target.root));
				void channel.stderr.pipeTo(new WritableStream()).catch(() => undefined);
				const ext = job.kind === 'database' ? 'sql' : 'tar';
				const buffer = new Uint8Array(job.partBytes);
				let filled = 0;
				let seq = 0;
				let bytes = 0;
				const flush = async () => {
					await blobs.put(partKey(job.prefix, seq, ext), buffer.slice(0, filled));
					seq++;
					filled = 0;
					await onPart?.();
				};
				const reader = channel.stdout.getReader();
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					bytes += value.byteLength;
					if (bytes > job.maxBytes) {
						await reader.cancel().catch(() => undefined);
						throw new ImportError(
							job.kind === 'database' ? 'restore_too_large' : 'files_too_large',
							`the ${job.kind} is larger than ${job.maxBytes} bytes, so the stream stopped`
						);
					}
					let at = 0;
					while (at < value.byteLength) {
						const take = Math.min(value.byteLength - at, job.partBytes - filled);
						buffer.set(value.subarray(at, at + take), filled);
						filled += take;
						at += take;
						if (filled === job.partBytes) await flush();
					}
				}
				if (filled > 0) await flush();
				const exit = await channel.exit;
				if (exit.code !== 0) {
					throw new ImportError(
						'dump_failed',
						`the ${job.kind} command on the server did not finish cleanly`
					);
				}
				return { parts: seq, bytes };
			} finally {
				await session.close().catch(() => undefined);
			}
		}
	};
}

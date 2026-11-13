import { describe, expect, it } from 'vitest';
import { createDumpStream, dumpCommand } from '../../../engine/src/adapters/dump-stream';
import { importKeys, partKey, readWindow } from '../../../engine/src/import-parts';
import type { DumpJob, SshTarget } from '../../../engine/src/ports';
import { fakeBlobs } from './backup-fakes';
import {
	fakeSource,
	KEY_MARKER,
	PRIVATE_IP,
	PRIVATE_KEY,
	PUBLIC_IP,
	ROOT,
	SERVER_FINGERPRINT,
	tarOf
} from './import-fakes';

const target = (expectedFingerprint = SERVER_FINGERPRINT): SshTarget => ({
	host: 'host.example',
	port: 22,
	user: 'deploy',
	privateKey: PRIVATE_KEY,
	expectedFingerprint,
	root: ROOT
});

const PREFIX = importKeys.dumpPrefix(`org_${'o'.repeat(26)}`, `op_${'p'.repeat(26)}`);
const job = (patch: Partial<DumpJob> = {}): DumpJob => ({
	kind: 'database',
	prefix: PREFIX,
	partBytes: 100,
	maxBytes: 10_000,
	...patch
});

const failureOf = async (promise: Promise<unknown>): Promise<Error> =>
	(await promise.then(
		() => new Error('expected a refusal'),
		(caught: unknown) => caught
	)) as Error;

describe('dumpCommand', () => {
	it('reads the database to stdout and tars the files to stdout', () => {
		expect(dumpCommand('database', '/srv/site')).toBe(
			"cd '/srv/site' && drush sql:dump --extra-dump=--hex-blob"
		);
		expect(dumpCommand('files', '/srv/site')).toBe(
			"tar -C '/srv/site/sites/default/files' -cf - ."
		);
	});

	it('quotes a path with a single quote so it cannot end the string', () => {
		expect(dumpCommand('database', "/srv/it's")).toContain("'/srv/it'\\''s'");
	});
});

describe('createDumpStream', () => {
	it('writes parts of the set size, the last one short, and reports the totals', async () => {
		const { connector } = fakeSource({ dump: 'a'.repeat(250) });
		const blobs = fakeBlobs();
		const result = await createDumpStream(connector, blobs.blobs).run(target(), job());
		expect(result).toEqual({ parts: 3, bytes: 250 });
		expect([...blobs.objects.keys()]).toEqual([
			partKey(PREFIX, 0, 'sql'),
			partKey(PREFIX, 1, 'sql'),
			partKey(PREFIX, 2, 'sql')
		]);
		expect(blobs.objects.get(partKey(PREFIX, 0, 'sql'))!.byteLength).toBe(100);
		expect(blobs.objects.get(partKey(PREFIX, 2, 'sql'))!.byteLength).toBe(50);
	});

	it('calls back after each part so a long step can keep its lease', async () => {
		const { connector } = fakeSource({ dump: 'a'.repeat(250) });
		let calls = 0;
		await createDumpStream(connector, fakeBlobs().blobs).run(target(), job(), async () => {
			calls++;
		});
		expect(calls).toBe(3);
	});

	it('overwrites the same part keys on a retry and drops parts the retry no longer has', async () => {
		const blobs = fakeBlobs();
		const first = fakeSource({ dump: 'a'.repeat(350) });
		await createDumpStream(first.connector, blobs.blobs).run(target(), job());
		const firstKeys = [...blobs.objects.keys()];
		expect(firstKeys).toHaveLength(4);

		const second = fakeSource({ dump: 'b'.repeat(150) });
		const result = await createDumpStream(second.connector, blobs.blobs).run(target(), job());
		expect(result).toEqual({ parts: 2, bytes: 150 });
		expect([...blobs.objects.keys()]).toEqual(firstKeys.slice(0, 2));
		const joined = await readWindow(
			blobs.blobs,
			(seq) => partKey(PREFIX, seq, 'sql'),
			100,
			150,
			0,
			150
		);
		expect(new TextDecoder().decode(joined)).toBe('b'.repeat(150));
	});

	it('stops above the byte limit with the code of the kind it was reading', async () => {
		const { connector } = fakeSource({ dump: 'a'.repeat(500) });
		const error = await failureOf(
			createDumpStream(connector, fakeBlobs().blobs).run(target(), job({ maxBytes: 200 }))
		);
		expect(error).toMatchObject({ code: 'restore_too_large' });
		const files = fakeSource({ files: 'a'.repeat(500) });
		const filesError = await failureOf(
			createDumpStream(files.connector, fakeBlobs().blobs).run(
				target(),
				job({ kind: 'files', maxBytes: 200 })
			)
		);
		expect(filesError).toMatchObject({ code: 'files_too_large' });
	});

	it('stores a files tar byte for byte under tar parts that a retry writes again', async () => {
		const tar = tarOf([
			{ name: './a.bin', body: new Uint8Array([0, 255, 128, 10, 0]) },
			{ name: './b.txt', body: 'b' }
		]);
		const { connector } = fakeSource({ files: tar });
		const blobs = fakeBlobs();
		const filesPrefix = importKeys.filesPrefix(`org_${'o'.repeat(26)}`, `op_${'p'.repeat(26)}`);
		const run = () =>
			createDumpStream(connector, blobs.blobs).run(
				target(),
				job({ kind: 'files', prefix: filesPrefix, partBytes: 1000 })
			);
		const first = await run();
		const keys = [...blobs.objects.keys()];
		expect(await run()).toEqual(first);
		expect([...blobs.objects.keys()]).toEqual(keys);
		expect(keys.every((key) => key.endsWith('.tar'))).toBe(true);
		const joined = await readWindow(
			blobs.blobs,
			(seq) => partKey(filesPrefix, seq, 'tar'),
			1000,
			first.bytes,
			0,
			first.bytes
		);
		expect(Buffer.from(joined).equals(Buffer.from(tar))).toBe(true);
	});

	it('fails a command that exits nonzero without quoting what the server wrote', async () => {
		const { connector } = fakeSource({ dump: 'a'.repeat(50), exitCode: 2 });
		const error = await failureOf(
			createDumpStream(connector, fakeBlobs().blobs).run(target(), job())
		);
		expect(error).toMatchObject({ code: 'dump_failed' });
		expect(error.message).not.toContain(KEY_MARKER);
	});

	it('refuses a host key that is not the confirmed one before any command', async () => {
		const { connector, sessions } = fakeSource({ dump: 'a'.repeat(50) });
		const error = await failureOf(
			createDumpStream(connector, fakeBlobs().blobs).run(target('SHA256:other'), job())
		);
		expect(error).toMatchObject({ code: 'host_key_mismatch' });
		expect(sessions[0]!.commands).toEqual([]);
		expect(error.message).not.toContain(KEY_MARKER);
	});

	it('closes the session on every path', async () => {
		const ok = fakeSource({ dump: 'a'.repeat(50) });
		await createDumpStream(ok.connector, fakeBlobs().blobs).run(target(), job());
		expect(ok.sessions[0]!.closed).toBe(true);
		const bad = fakeSource({ dump: 'a'.repeat(50), exitCode: 1 });
		await failureOf(createDumpStream(bad.connector, fakeBlobs().blobs).run(target(), job()));
		expect(bad.sessions[0]!.closed).toBe(true);
	});
});

describe('the address that is dialled', () => {
	it('dials the address that passed the check and not the name', async () => {
		const { connector, sessions, lookups } = fakeSource({ dump: 'a'.repeat(50) });
		await createDumpStream(connector, fakeBlobs().blobs).run(target(), job());
		expect(lookups.calls).toEqual(['host.example']);
		expect(sessions[0]!.options.hostname).toBe(PUBLIC_IP);
	});

	it('refuses a name that was public on one connection and is private on the next, before it connects', async () => {
		const { connector, sessions } = fakeSource({
			dump: 'a'.repeat(50),
			lookups: [[PUBLIC_IP], [PRIVATE_IP]]
		});
		const stream = createDumpStream(connector, fakeBlobs().blobs);
		await stream.run(target(), job());
		expect(sessions).toHaveLength(1);
		const error = await failureOf(stream.run(target(), job()));
		expect(error).toMatchObject({ code: 'source_host_private' });
		expect(sessions).toHaveLength(1);
	});

	it('refuses a name with one private address among public ones', async () => {
		const { connector, sessions } = fakeSource({ lookups: [[PUBLIC_IP, PRIVATE_IP]] });
		const error = await failureOf(
			createDumpStream(connector, fakeBlobs().blobs).run(target(), job())
		);
		expect(error).toMatchObject({ code: 'source_host_private' });
		expect(sessions).toEqual([]);
	});

	it('refuses a private literal without a lookup or a connection', async () => {
		const { connector, sessions, lookups } = fakeSource();
		const error = await failureOf(
			createDumpStream(connector, fakeBlobs().blobs).run(
				{ ...target(), host: PRIVATE_IP },
				job()
			)
		);
		expect(error).toMatchObject({ code: 'source_host_private' });
		expect(error.message).not.toContain(PRIVATE_KEY);
		expect(lookups.calls).toEqual([]);
		expect(sessions).toEqual([]);
	});

	it('refuses a name that does not resolve as unreachable, before it connects', async () => {
		const { connector, sessions } = fakeSource({ lookups: [[]] });
		const error = await failureOf(
			createDumpStream(connector, fakeBlobs().blobs).run(target(), job())
		);
		expect(error).toMatchObject({ code: 'source_unreachable' });
		expect(sessions).toEqual([]);
	});
});

describe('readWindow', () => {
	it('reads across a part boundary and stops at the total', async () => {
		const { connector } = fakeSource({ dump: 'abcdefghij'.repeat(25) });
		const blobs = fakeBlobs();
		await createDumpStream(connector, blobs.blobs).run(target(), job());
		const keyOf = (seq: number) => partKey(PREFIX, seq, 'sql');
		const middle = await readWindow(blobs.blobs, keyOf, 100, 250, 95, 10);
		expect(new TextDecoder().decode(middle)).toBe('fghijabcde');
		const tail = await readWindow(blobs.blobs, keyOf, 100, 250, 240, 100);
		expect(tail.byteLength).toBe(10);
	});

	it('names a missing part with a plain code', async () => {
		const blobs = fakeBlobs();
		const error = await failureOf(
			readWindow(blobs.blobs, (seq) => partKey(PREFIX, seq, 'sql'), 100, 250, 0, 50)
		);
		expect(error).toMatchObject({ code: 'part_missing' });
	});
});

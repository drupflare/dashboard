import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// bun scripts/spikes/import-rig/run.ts <key.pem> <sshPort> <fingerprint> <site> [partBytes]
// Posts one run to the rig on :8791 and samples the resident memory of the two workerd processes
// that listen on :8791 (the rig) and :8793 (the local worker the database lands in).
const [keyPath, sshPort, fingerprint, site, partBytes] = process.argv.slice(2);
if (!keyPath || !sshPort || !fingerprint || !site) throw new Error('missing argument');

const pidOn = (port: number): number | null => {
	try {
		const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).toString();
		return Number(out.split('\n')[0]) || null;
	} catch {
		return null;
	}
};
const rssMb = (pid: number | null): number => {
	if (pid === null) return 0;
	try {
		return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString()) / 1024;
	} catch {
		return 0;
	}
};

const rigPid = pidOn(8791);
const workerPid = pidOn(8793);
const peak = { rig: rssMb(rigPid), worker: rssMb(workerPid) };
const start = { ...peak };
const timer = setInterval(() => {
	peak.rig = Math.max(peak.rig, rssMb(rigPid));
	peak.worker = Math.max(peak.worker, rssMb(workerPid));
}, 100);

const began = performance.now();
const response = await fetch('http://127.0.0.1:8791/', {
	method: 'POST',
	body: JSON.stringify({
		host: 'source.example.test',
		dialHost: '127.0.0.1',
		port: Number(sshPort),
		user: 'tester',
		privateKey: readFileSync(keyPath, 'utf8'),
		expectedFingerprint: fingerprint,
		root: '/opt/drupal/web',
		landBase: 'http://127.0.0.1:8793',
		site,
		...(partBytes === undefined ? {} : { partBytes: Number(partBytes) })
	})
});
const wallMs = Math.round(performance.now() - began);
clearInterval(timer);
const body = (await response.json()) as Record<string, unknown>;
// the survey carries host data, so only counts and the step table leave this script
const survey = body.survey as { files?: unknown; database?: unknown; drupal?: unknown } | undefined;
console.log(
	JSON.stringify(
		{
			status: response.status,
			wallMs,
			rssMb: { start, peak },
			error: body.error,
			code: body.code,
			refusals: body.refusals,
			survey: survey && {
				files: survey.files,
				database: survey.database,
				drupal: survey.drupal
			},
			dossier: body.dossier,
			dump: body.dump && { ...(body.dump as object), keys: undefined },
			retry: body.retry && { ...(body.retry as object), keys: undefined },
			files: body.files,
			private: body.private,
			fileRows: body.fileRows,
			convert: body.convert,
			convertSteps: (body.convertSteps as unknown[] | undefined)?.length,
			slowestConvertStepMs: Math.max(
				0,
				...((body.convertSteps as { ms: number }[] | undefined) ?? []).map((s) => s.ms)
			),
			landing: body.landing,
			steps: body.steps
		},
		null,
		1
	)
);

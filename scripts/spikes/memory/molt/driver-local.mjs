import { execFile, spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const WRANGLER = '/Users/gamer/gmitch215/drupflare/dashboard/node_modules/.bin/wrangler';
const CONFIG = new URL('./wrangler.local.jsonc', import.meta.url).pathname;
const PERSIST = process.env.MOLT_PERSIST_DIR;
if (!PERSIST) throw new Error('MOLT_PERSIST_DIR is not set');
const OUT = new URL('./rows-local.jsonl', import.meta.url);
const RUN = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const SEED = 20261112;
const PORT = 8797;
const INSPECT = 9797;
const BASE = `http://127.0.0.1:${PORT}`;
const N = 5;
const OBSERVE_MS = 15000;
const SMOKE = process.argv.includes('--smoke');
const CELLS = ['idle', 'copy', 'churn-short', 'churn-long', 'return-create', 'abort'];

function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffle(xs, rand) {
	const out = [...xs];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function emit(obj) {
	appendFileSync(OUT, JSON.stringify({ run: RUN, seed: SEED, ...obj }) + '\n');
}

function exec(cmd, args) {
	return new Promise((resolve, reject) =>
		execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(stdout)))
	);
}

const units = [];
for (const cell of CELLS) {
	for (let i = 1; i <= N; i++) {
		units.push({ kind: 'do', cell, index: i });
		if (cell !== 'abort') units.push({ kind: 'plain', cell, index: i });
	}
}
const order = shuffle(units, rng(SEED));
const plan = SMOKE ? order.slice(0, 1) : order;
emit({
	type: 'manifest',
	units: plan.length,
	order: plan.map((u) => `${u.kind}-${u.cell}-${u.index}`),
	smoke: SMOKE
});

async function startWrangler() {
	const child = spawn(
		WRANGLER,
		[
			'dev',
			'--config',
			CONFIG,
			'--port',
			String(PORT),
			'--inspector-port',
			String(INSPECT),
			'--ip',
			'127.0.0.1',
			'--persist-to',
			PERSIST,
			'--show-interactive-dev-session=false'
		],
		{ stdio: ['ignore', 'pipe', 'pipe'] }
	);
	let log = '';
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('wrangler not ready in 90 s')), 90000);
		const on = (d) => {
			log += d;
			if (/Ready on/.test(log)) {
				clearTimeout(timer);
				resolve();
			}
		};
		child.stdout.on('data', on);
		child.stderr.on('data', on);
		child.on('exit', (code) => {
			clearTimeout(timer);
			reject(new Error(`wrangler exited ${code} before ready: ${log.slice(-400)}`));
		});
	});
	return child;
}

// every workerd under wrangler: the runtime and its proxy are separate processes
async function workerdPids(rootPid) {
	for (let attempt = 0; attempt < 20; attempt++) {
		const out = await exec('ps', ['-axo', 'pid=,ppid=,command=']);
		const procs = out
			.split('\n')
			.map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
			.filter(Boolean)
			.map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
		const kids = new Map();
		for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
		const found = [];
		const queue = [rootPid];
		while (queue.length) {
			const cur = queue.shift();
			for (const k of kids.get(cur) ?? []) {
				found.push(k);
				queue.push(k.pid);
			}
		}
		const hits = found.filter((p) => /workerd/.test(p.cmd)).map((p) => p.pid);
		if (hits.length) return hits;
		await sleep(300);
	}
	return [];
}

async function rssKiB(pids) {
	try {
		const out = await exec('ps', ['-o', 'rss=', '-p', pids.join(',')]);
		return out
			.trim()
			.split('\n')
			.reduce((sum, l) => sum + Number(l.trim()), 0);
	} catch {
		return null;
	}
}

function startSampler(pids, id, t0) {
	let on = true;
	const loop = (async () => {
		while (on) {
			const kib = await rssKiB(pids);
			if (kib !== null) emit({ type: 'rss', unit: id, t: Date.now() - t0, rssKiB: kib });
			await sleep(500);
		}
	})();
	return async () => {
		on = false;
		await loop;
	};
}

async function call(unit, object, op, params = {}) {
	const u = unit.kind === 'do' ? new URL(`${BASE}/call`) : new URL(`${BASE}/plain`);
	if (unit.kind === 'do') u.searchParams.set('name', object);
	u.searchParams.set('op', op);
	for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
	const t = Date.now();
	try {
		const res = await fetch(u);
		const body = await res.json();
		return { t, httpStatus: res.status, ...body };
	} catch (e) {
		return { t, ok: false, error: `driver: ${e.message}` };
	}
}

function pick(r) {
	return {
		ok: r.ok === true,
		error: r.ok ? null : (r.error ?? null),
		httpStatus: r.httpStatus ?? null,
		incarnation: r.incarnation ?? null,
		isolate: r.isolate ?? null,
		linearMiB: r.linearMiB ?? null,
		ballastMiB: r.ballastMiB ?? null,
		keptMiB: r.keptMiB ?? null,
		droppedAlive: r.droppedAlive ?? null,
		copyMs: r.copyMs ?? null,
		churnSteps: r.churnSteps ?? null,
		opMs: r.opMs ?? null
	};
}

function waitExit(child, ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			resolve(false);
		}, ms);
		child.on('exit', () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

// true when none of the pids is still alive
async function pidsGone(pids) {
	try {
		await exec('ps', ['-p', pids.join(',')]);
		return false;
	} catch {
		return true;
	}
}

async function runUnit(unit, position) {
	const id = `${unit.kind}-${unit.cell}-${unit.index}`;
	const object = `${RUN}-${position}-${id}`;
	const t0 = Date.now();
	const ev = (name, extra = {}) =>
		emit({ type: 'event', unit: id, position, name, t: Date.now() - t0, ...extra });
	const c = (op, params) => call(unit, object, op, params);
	const rec = (name, r) => ev(name, pick(r));

	let child = null;
	let stopSampler = null;
	let pids = [];
	try {
		child = await startWrangler();
		pids = await workerdPids(child.pid);
		if (!pids.length) throw new Error('workerd process not found under wrangler');
		stopSampler = startSampler(pids, id, t0);
		ev('ready', { workerdCount: pids.length });

		if (unit.kind === 'do') {
			rec('init', await c('init', { mb: 64 }));
			rec('grow', await c('grow', { mb: 170 }));
			rec('drop', await c('drop'));
		} else {
			rec('setup', await c('setup'));
		}

		if (unit.cell === 'copy') rec('action', await c('copy'));
		else if (unit.cell === 'churn-short') {
			rec('action', await c('churn', { mb: 8, interval: 500, n: 24, mode: 'short' }));
		} else if (unit.cell === 'churn-long') {
			rec('action', await c('churn', { mb: 2, interval: 500, n: 24, mode: 'long' }));
		} else if (unit.cell === 'return-create') rec('action', await c('create', { mb: 64 }));
		else if (unit.cell === 'abort') {
			rec('ping-before-abort', await c('ping'));
			rec('action', await c('abort'));
			rec('ping-after-abort', await c('ping'));
		}

		ev('action-end');
		await sleep(OBSERVE_MS / 3);
		rec('ping-mid', await c('ping'));
		await sleep((OBSERVE_MS * 2) / 3);
		rec('ping-final', await c('ping'));
	} catch (e) {
		ev('error', { error: e.message });
	} finally {
		if (stopSampler) await stopSampler();
		if (child) {
			child.kill('SIGINT');
			await waitExit(child, 10000);
		}
		const gone = pids.length ? await pidsGone(pids) : null;
		emit({
			type: 'event',
			unit: id,
			position,
			name: 'stopped',
			workerdGone: gone,
			t: Date.now() - t0
		});
	}
}

for (let k = 0; k < plan.length; k++) {
	await runUnit(plan[k], k);
	console.log(`unit ${k + 1}/${plan.length} done`);
}
console.log('all done');

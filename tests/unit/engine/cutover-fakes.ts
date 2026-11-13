import type { CutoverDestination, CutoverPorts, CutoverSource } from '../../../engine/src/ports';
import { StepFailed } from '../../../engine/src/step';
import type { CutoverRunner } from '../../../engine/src/workflows/migration-cutover';
import { makeRunner, type Memo, type RunnerScript } from './fakes';

export type Observation = { healthy: boolean; writes?: number } | 'throw';

export interface CutoverOptions {
	// what the nth validate call answers, 1-based; absent means the copy matches
	validate?: Record<number, string>;
	observations?: Observation[];
	// runs when the source takes its write policy, to model a write arriving at that moment
	atFreeze?: (world: CutoverWorld) => void;
	// a port call that throws, by method name, until it has failed this many times
	fail?: Record<string, number>;
}

const ALLOWED_CALLS = [
	'lowerTtl',
	'restoreTtl',
	'snapshot',
	'delta',
	'applyWritePolicy',
	'restoreWrites',
	'validate',
	'promote',
	'route',
	'acceptedWrites',
	'observe',
	'exportChanges'
];

// the fake source and destination keep what an owner could see: the writes each accepted, where the
// address points and which calls ran; a call with a key that already ran changes nothing
export function fakeCutover(options: CutoverOptions = {}) {
	const world = {
		ttl: 3600,
		policy: null as 'freeze' | 'read-only' | 'delta' | null,
		sourceWrites: [] as string[],
		refused: [] as string[],
		routedTo: 'source' as 'source' | 'destination',
		destinationWrites: 0,
		promoted: null as { snapshot: string; delta: string } | null,
		snapshotLength: -1,
		effects: [] as string[],
		calls: [] as string[],
		validateCalls: 0,
		observeCalls: 0,
		exported: 0
	};
	const results = new Map<string, unknown>();
	const failures = { ...options.fail };
	// a call with this key has run before, so the saved answer comes back and nothing changes
	async function once<T>(method: string, key: string | null, run: () => T): Promise<T> {
		world.calls.push(method);
		if ((failures[method] ?? 0) > 0) {
			failures[method]!--;
			throw new Error(`${method} is unavailable`);
		}
		if (key === null) return run();
		const id = `${method}:${key}`;
		if (results.has(id)) return results.get(id) as T;
		const value = run();
		world.effects.push(method);
		results.set(id, value);
		return value;
	}
	const source: CutoverSource = {
		lowerTtl: (key, _host, ttl) =>
			once('lowerTtl', key, () => {
				const previous = world.ttl;
				world.ttl = ttl;
				return { previousTtlSeconds: previous };
			}),
		restoreTtl: (key, _host, ttl) =>
			once('restoreTtl', key, () => {
				world.ttl = ttl;
			}),
		snapshot: (key) =>
			once('snapshot', key, () => {
				world.snapshotLength = world.sourceWrites.length;
				return { marker: `snap-${world.sourceWrites.length}` };
			}),
		delta: (key) =>
			once('delta', key, () => ({ marker: `delta-${world.sourceWrites.length}` })),
		applyWritePolicy: (key, policy) =>
			once('applyWritePolicy', key, () => {
				world.policy = policy;
				options.atFreeze?.(world as CutoverWorld);
			}),
		restoreWrites: (key) =>
			once('restoreWrites', key, () => {
				world.policy = null;
			})
	};
	const destination: CutoverDestination = {
		validate: (key) =>
			once('validate', key, () => {
				world.validateCalls++;
				return options.validate?.[world.validateCalls] ?? null;
			}),
		promote: (key, snapshot, delta) =>
			once('promote', key, () => {
				world.promoted = { snapshot, delta };
			}),
		route: (key, to) =>
			once('route', key, () => {
				world.routedTo = to;
			}),
		acceptedWrites: () => once('acceptedWrites', null, () => world.destinationWrites),
		observe: () =>
			once('observe', null, () => {
				const next = options.observations?.[world.observeCalls++] ?? { healthy: true };
				if (next === 'throw') throw new Error('the new site did not answer');
				return { healthy: next.healthy, writes: next.writes ?? world.destinationWrites };
			}),
		exportChanges: (key) =>
			once('exportChanges', key, () => {
				world.exported++;
				return {
					reference: `export-${world.destinationWrites}`,
					cannotCarry: ['uploaded files']
				};
			})
	};
	const ports: CutoverPorts = { source: () => source, destination: () => destination };
	return {
		world: world as CutoverWorld,
		ports,
		sourceWrite(name: string): boolean {
			if (world.policy !== null) {
				world.refused.push(name);
				return false;
			}
			world.sourceWrites.push(name);
			return true;
		},
		destinationWrite(count = 1) {
			world.destinationWrites += count;
		},
		// the source offers nothing that destroys it, so no call can
		onlyAllowedCalls: () => world.calls.every((call) => ALLOWED_CALLS.includes(call))
	};
}

export type CutoverWorld = {
	ttl: number;
	policy: 'freeze' | 'read-only' | 'delta' | null;
	sourceWrites: string[];
	refused: string[];
	routedTo: 'source' | 'destination';
	destinationWrites: number;
	promoted: { snapshot: string; delta: string } | null;
	snapshotLength: number;
	effects: string[];
	calls: string[];
	validateCalls: number;
	observeCalls: number;
	exported: number;
};

export type Heard = { payload: unknown } | null;

export interface WaitCall {
	name: string;
	type: string;
	timeoutMs: number;
	// 1-based count of waits of this type so far
	nth: number;
}

// what each wait answers; a wait the script has no answer for runs out
export type WaitScript = (call: WaitCall) => Heard | undefined | Promise<Heard | undefined>;

// the runner of the other engine specs, with waits that are saved and replayed like steps
export function makeCutoverRunner(
	memo: Memo,
	options: {
		waits?: WaitScript;
		advance?: (ms: number) => void;
		script?: RunnerScript;
	} = {}
) {
	const { runner, executed } = makeRunner(memo, options.script);
	const seen = new Map<string, number>();
	const waits: WaitCall[] = [];
	const cutover: CutoverRunner = {
		do: runner.do.bind(runner),
		async wait(name, type, timeoutMs) {
			const saved = memo.get(`wait:${name}`);
			if (saved?.ok) return saved.value as Heard;
			const nth = (seen.get(type) ?? 0) + 1;
			seen.set(type, nth);
			const call = { name, type, timeoutMs, nth };
			waits.push(call);
			const answer = await options.waits?.(call);
			const heard = answer === undefined ? null : answer;
			options.advance?.(heard === null ? timeoutMs : Math.min(timeoutMs, 1_000));
			memo.set(`wait:${name}`, { ok: true, value: heard });
			return heard;
		}
	};
	return { runner: cutover, executed, waits };
}

export { StepFailed };

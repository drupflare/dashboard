import type {
	CutoverDestination,
	CutoverPorts,
	CutoverSource,
	MarkIncomplete,
	WriteMarkWorker
} from '../../../engine/src/ports';
import { StepFailed } from '../../../engine/src/step';
import type { CutoverRunner } from '../../../engine/src/workflows/migration-cutover';
import { makeRunner, type Memo, type RunnerScript } from './fakes';

export type Observation = { healthy: boolean; writes?: number } | 'throw';

export interface CutoverOptions {
	// what the nth validate call answers, 1-based; absent means the copy matches
	validate?: Record<number, string>;
	observations?: Observation[];
	// the new site opens the count with the copy, as a worker that takes the mark on its restore does
	opensCount?: boolean;
	// the statements the read after the address moved back finds
	finalStatements?: number;
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
	'startCounting',
	'stopCounting',
	'acceptedWrites',
	'observe',
	'exportChanges',
	'exportFinalChanges'
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
		sourceOf: [] as { ref: string; orgId: string }[],
		routeHostnames: [] as string[],
		destinationWrites: 0,
		promoted: null as { snapshot: string; delta: string } | null,
		snapshotLength: -1,
		effects: [] as string[],
		calls: [] as string[],
		validateCalls: 0,
		observeCalls: 0,
		exported: 0,
		counting: false,
		countStarts: 0,
		countEnds: 0,
		countKeys: [] as string[],
		countOpenedWithCopy: 0,
		finalSince: [] as number[]
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
				if (options.opensCount !== true) return { counting: false };
				world.counting = true;
				world.countOpenedWithCopy++;
				return { counting: true };
			}),
		route: (key, to, hostname) =>
			once('route', key, () => {
				world.routedTo = to;
				world.routeHostnames.push(hostname);
			}),
		startCounting: (key) =>
			once('startCounting', key, () => {
				world.counting = true;
				world.countStarts++;
			}),
		stopCounting: (key) =>
			once('stopCounting', key, () => {
				world.counting = false;
				world.countEnds++;
			}),
		acceptedWrites: (key) => {
			world.countKeys.push(key);
			return once('acceptedWrites', null, () => world.destinationWrites);
		},
		observe: () =>
			once('observe', null, () => {
				const next = options.observations?.[world.observeCalls++] ?? { healthy: true };
				if (next === 'throw') throw new Error('the new site did not answer');
				return { healthy: next.healthy, writes: next.writes ?? world.destinationWrites };
			}),
		exportChanges: (key, dialect) =>
			once('exportChanges', key, () => {
				if (dialect !== 'mysql') throw new Error('the changes are written for MySQL');
				world.exported++;
				return {
					reference: `export-${world.destinationWrites}`,
					cannotCarry: ['uploaded files'],
					through: world.destinationWrites
				};
			}),
		exportFinalChanges: (key, dialect, since) =>
			once('exportFinalChanges', key, () => {
				if (dialect !== 'mysql') throw new Error('the changes are written for MySQL');
				world.finalSince.push(since);
				return {
					cannotCarry: ['uploaded files'],
					statements: options.finalStatements ?? 0
				};
			})
	};
	const ports: CutoverPorts = {
		source: (ref, orgId) => {
			world.sourceOf.push({ ref, orgId });
			return source;
		},
		destination: () => destination
	};
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
	sourceOf: { ref: string; orgId: string }[];
	routeHostnames: string[];
	destinationWrites: number;
	promoted: { snapshot: string; delta: string } | null;
	snapshotLength: number;
	effects: string[];
	calls: string[];
	validateCalls: number;
	observeCalls: number;
	exported: number;
	counting: boolean;
	countStarts: number;
	countEnds: number;
	countKeys: string[];
	countOpenedWithCopy: number;
	finalSince: number[];
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

// #region the new site's write count

export interface MarksOptions {
	// a site that predates the routes
	supported?: boolean;
	// a mark another move left behind
	mark?: string | null;
	writes?: number;
	incomplete?: MarkIncomplete | null;
	cannotCarry?: string[];
	// a site that predates `since`: it answers the whole list and does not say where it starts
	ignoresSince?: boolean;
	// the body each attempt streams, in order; the last one repeats
	bodies?: string[][];
	// the body for the writes after `since` up to `through`, in place of `bodies`
	windows?: (since: number, through: number) => string[];
	// a call that throws, by method name, until it has failed this many times
	fail?: Record<string, number>;
}

export const changeBody = (statements: string[], end: number | null = statements.length) =>
	[
		'-- changes through write 3, mysql\n',
		...statements.map((statement) => `${statement}\n`),
		...(end === null ? [] : [`-- end, ${end} statement${end === 1 ? '' : 's'}\n`])
	].join('');

// a site's mark state: starting is idempotent per id, a different id is taken, and the count only
// rises. The calls it saw are kept so a test can say what ran
export function fakeMarks(options: MarksOptions = {}) {
	const state = {
		supported: options.supported ?? true,
		mark: options.mark ?? (null as string | null),
		writes: options.writes ?? 0,
		incomplete: options.incomplete ?? (null as MarkIncomplete | null),
		cannotCarry: options.cannotCarry ?? ['sessions'],
		calls: [] as string[],
		starts: 0,
		ends: 0,
		bodiesRead: 0,
		asked: [] as [number, number][]
	};
	const failures = { ...options.fail };
	const bodies = options.bodies ?? [[changeBody(['REPLACE INTO `node` (`nid`) VALUES (1);'])]];
	const enter = (method: string) => {
		state.calls.push(method);
		if ((failures[method] ?? 0) > 0) {
			failures[method]!--;
			throw new Error(`${method} answered 503`);
		}
	};
	const worker: WriteMarkWorker = {
		async supported() {
			enter('supported');
			return state.supported;
		},
		async start(_host, mark) {
			enter('start');
			if (!state.supported) return 'missing';
			if (state.mark === mark) return 'existing';
			if (state.mark !== null) return 'taken';
			state.mark = mark;
			state.writes = 0;
			state.starts++;
			return 'started';
		},
		async read() {
			enter('read');
			if (!state.supported) return 'missing';
			if (state.mark === null) return 'none';
			return { mark: state.mark, writes: state.writes, incomplete: state.incomplete };
		},
		async end(_host, mark) {
			enter('end');
			if (state.mark === mark) {
				state.mark = null;
				state.ends++;
			}
		},
		async manifest(_host, _auth, through) {
			enter('manifest');
			if (!state.supported) return 'missing';
			if (state.mark === null) return 'none';
			return {
				mark: state.mark,
				writes: state.writes,
				incomplete: state.incomplete,
				through: through ?? state.writes,
				cannotCarry: state.cannotCarry
			};
		},
		async body(_host, through, _auth, since) {
			enter('body');
			state.asked.push([since ?? 0, through]);
			const nth = state.bodiesRead++;
			const chunks = options.windows
				? options.windows(options.ignoresSince ? 0 : (since ?? 0), through)
				: bodies[Math.min(nth, bodies.length - 1)]!;
			const encoder = new TextEncoder();
			let at = 0;
			return {
				stream: new ReadableStream<Uint8Array>({
					pull(controller) {
						const chunk = chunks[at++];
						if (chunk === undefined) controller.close();
						else controller.enqueue(encoder.encode(chunk));
					}
				}),
				through,
				since: options.ignoresSince ? -1 : (since ?? 0),
				incomplete: state.incomplete
			};
		}
	};
	return { worker, state };
}

// #endregion

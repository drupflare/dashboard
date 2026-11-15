import { revisionOf } from '../../../engine/src/modify-bundle';
import type { ModifyAnswer, ModifyFile, ModifyWorker } from '../../../engine/src/ports';

// an in-memory site that keeps revisions per package, so a workflow can read the answer back
export function fakeModify() {
	const active = new Map<string, string | null>();
	const revisions = new Map<string, Map<string, ModifyFile[]>>();
	const calls = {
		reads: 0,
		delivers: [] as { name: string; label: string; files: readonly ModifyFile[] }[],
		activates: [] as string[],
		bearers: new Set<string>()
	};
	const script = {
		// 'refuse' answers a refused commit that leaves the old revision, 'refuse-after-write' leaves
		// the new one running, and 'wrong-rev' reports another revision than the one sent
		deliver: 'apply' as 'apply' | 'refuse' | 'refuse-after-write' | 'wrong-rev',
		refusal: 'rolled back: the kernel refused to boot',
		activateOk: true,
		// runs inside deliver after the set is stored, to model a lost answer
		afterStore: undefined as (() => void) | undefined,
		readFails: false
	};
	const worker: ModifyWorker = {
		async active(_host, name, auth) {
			calls.bearers.add(auth.bearer);
			calls.reads++;
			if (script.readFails) throw new Error('the site is gone');
			return active.get(name) ?? null;
		},
		async deliver(_host, delivery, auth): Promise<ModifyAnswer> {
			calls.bearers.add(auth.bearer);
			calls.delivers.push(delivery);
			if (script.deliver === 'refuse') return { kind: 'refused', reason: script.refusal };
			const rev = await revisionOf({
				v: 1,
				package: delivery.name,
				files: delivery.files.map((file) => ({ ...file }))
			});
			const byRev = revisions.get(delivery.name) ?? new Map<string, ModifyFile[]>();
			byRev.set(rev, [...delivery.files]);
			revisions.set(delivery.name, byRev);
			active.set(delivery.name, rev);
			script.afterStore?.();
			if (script.deliver === 'refuse-after-write') {
				return { kind: 'refused', reason: script.refusal };
			}
			return { kind: 'applied', rev: script.deliver === 'wrong-rev' ? 'other' : rev };
		},
		async activate(_host, name, rev, auth) {
			calls.bearers.add(auth.bearer);
			calls.activates.push(rev);
			if (!script.activateOk) return { ok: false };
			active.set(name, rev);
			return { ok: true };
		}
	};
	return { worker, calls, script, active, revisions };
}

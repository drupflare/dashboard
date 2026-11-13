// one map per module instance: every object of the class in the isolate writes here
const seen = new Map();
let instance = null;

export function residency(self, bytes, now, windowMs = 120000) {
	instance ??= crypto.randomUUID();
	seen.set(self, { at: now, bytes });
	let others = 0;
	let otherBytes = 0;
	for (const [id, v] of seen) {
		if (now - v.at >= windowMs) seen.delete(id);
		else if (id !== self) {
			others++;
			otherBytes += v.bytes;
		}
	}
	return { instance, others, otherBytes };
}

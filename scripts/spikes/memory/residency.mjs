// one map per module instance: every object of the class in the isolate writes here
const seen = new Map();
let instance = null;

export function residency(self, now, windowMs = 120_000) {
	instance ??= crypto.randomUUID();
	seen.set(self, now);
	let others = 0;
	for (const [id, at] of seen) {
		if (now - at >= windowMs) {
			seen.delete(id);
			continue;
		}
		if (id !== self) others++;
	}
	return `${instance};others=${others}`;
}

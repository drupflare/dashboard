// reads process.memoryUsage() around one 64 MiB wasm memory, before and after touching it
const MiB = 1024 * 1024;

function read() {
	const m = process.memoryUsage();
	return { external: m.external / MiB, arrayBuffers: m.arrayBuffers / MiB, rss: m.rss / MiB };
}

const before = read();
const mem = new WebAssembly.Memory({ initial: 1024 });
const afterCreate = read();

const u8 = new Uint8Array(mem.buffer);
for (let i = 0; i < u8.length; i += 4096) u8[i] = 1;
const afterTouch = read();

console.log(
	JSON.stringify({
		node: process.version,
		linearMiB: mem.buffer.byteLength / MiB,
		before,
		afterCreate,
		afterTouch,
		deltaExternalCreateMiB: afterCreate.external - before.external,
		deltaArrayBuffersCreateMiB: afterCreate.arrayBuffers - before.arrayBuffers,
		deltaExternalTouchMiB: afterTouch.external - before.external,
		deltaArrayBuffersTouchMiB: afterTouch.arrayBuffers - before.arrayBuffers
	})
);

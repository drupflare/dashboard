// grows a wasm memory from 64 MiB to 170.6 MiB in 8 MiB steps, touching every page, and prints one json line
const MiB = 1024 * 1024;
const PAGE = 65536;
const fromPages = (64 * MiB) / PAGE;
const toPages = Math.ceil((170.6 * MiB) / PAGE);
const stepPages = (8 * MiB) / PAGE;
const stride = 4096;

const mem = new WebAssembly.Memory({ initial: fromPages, maximum: toPages });

function touch(fromByte, toByte) {
	const u8 = new Uint8Array(mem.buffer);
	for (let i = fromByte; i < toByte; i += stride) u8[i] = 1;
}

touch(0, fromPages * PAGE);
const rssBefore = process.memoryUsage().rss;

const cpu0 = process.cpuUsage();
const t0 = performance.now();
let pages = fromPages;
while (pages < toPages) {
	const step = Math.min(stepPages, toPages - pages);
	mem.grow(step);
	touch(pages * PAGE, (pages + step) * PAGE);
	pages += step;
}
const wallMs = performance.now() - t0;
const cpu = process.cpuUsage(cpu0);

const ru = process.resourceUsage();
console.log(
	JSON.stringify({
		node: process.version,
		execArgv: process.execArgv,
		linearMiB: mem.buffer.byteLength / MiB,
		rssBeforeClimbMiB: rssBefore / MiB,
		rssEndMiB: process.memoryUsage().rss / MiB,
		maxRSSRaw: ru.maxRSS,
		climbCpuMs: (cpu.user + cpu.system) / 1000,
		climbWallMs: wallMs
	})
);

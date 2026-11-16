import { writeFileSync } from 'node:fs';
import { chromium, firefox, webkit } from 'playwright';

const B = 'http://127.0.0.1:8799';
const N = Number(process.env.N ?? 10);
const types = { chromium, firefox, webkit };
const get = async (path) => (await fetch(`${B}${path}`)).json();
const mode = (query) => get(`/__mode?${query}`);
const reset = () => get('/__reset');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const total = (hits) => Object.values(hits).reduce((a, b) => a + b, 0);

async function settle(page, ms = 400) {
	await page.waitForLoadState('load');
	await sleep(ms);
}

async function controlled(page) {
	await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, {
		timeout: 15000
	});
	await page.waitForFunction(
		async () => {
			const names = await caches.keys();
			for (const n of names) {
				const keys = await (await caches.open(n)).keys();
				if (keys.some((r) => r.url.endsWith('/spool.json'))) return true;
			}
			return false;
		},
		null,
		{ timeout: 15000 }
	);
	await sleep(400);
}

async function nav(page, id) {
	await reset();
	await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click(`#${id}`)]);
	await sleep(500);
	return get('/__hits');
}

async function regs(page) {
	return page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
}

async function arm(name, type, client, store = false) {
	await mode(`kill=0&noclient=${client ? 0 : 1}&swAge=86400&htmlStore=${store ? 1 : 0}`);
	const browser = await types[type].launch();
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	const out = { arm: name };
	try {
		await page.goto(`${B}/docs/a`);
		if (client) await controlled(page);
		else await sleep(800);
		out.second = await nav(page, 'to-b');
		if (name.startsWith('spool')) {
			await sleep(300);
			await nav(page, 'to-c');
			out.revisit = await nav(page, 'to-b');
			out.fresh = await nav(page, 'to-d');
			await nav(page, 'to-b');
			await reset();
			await page.reload({ waitUntil: 'load' });
			await sleep(500);
			out.reload = await get('/__hits');
			if (type === 'chromium') {
				const cdp = await ctx.newCDPSession(page);
				await cdp.send('Network.setBypassServiceWorker', { bypass: true });
				await reset();
				await cdp.send('Page.reload', { ignoreCache: true });
				await page.waitForLoadState('load');
				await sleep(500);
				out.bypassReload = await get('/__hits');
				await cdp.send('Network.setBypassServiceWorker', { bypass: false });
			}
			if (type !== 'chromium') {
				await reset();
				await page.keyboard.press(type === 'webkit' ? 'Meta+Shift+R' : 'Control+Shift+R');
				await sleep(1500);
				out.keyboardReload = await get('/__hits');
			}
			out.unlisted = await nav(page, 'to-missing');
		} else {
			await nav(page, 'to-c');
			out.revisit = await nav(page, 'to-b');
			out.fresh = await nav(page, 'to-d');
		}
	} catch (e) {
		out.error = String(e).split('\n')[0];
	}
	await browser.close();
	return out;
}

async function kill(type, swAge) {
	await mode(`kill=0&noclient=0&htmlStore=0&swAge=${swAge}`);
	const browser = await types[type].launch();
	const page = await (await browser.newContext()).newPage();
	const out = { arm: `kill-swAge${swAge}` };
	try {
		await page.goto(`${B}/docs/a`);
		await controlled(page);
		await nav(page, 'to-b');
		await nav(page, 'to-c');
		await nav(page, 'to-d');
		await mode(`kill=1&swAge=${swAge}`);
		out.regsBefore = await regs(page);
		out.nav1 = await nav(page, 'to-b');
		await sleep(2500);
		out.regsAfterNav1 = await regs(page);
		out.nav2 = await nav(page, 'to-c');
		await sleep(2500);
		out.regsAfterNav2 = await regs(page);
		out.nav3 = await nav(page, 'to-d');
		out.tagInDom = await page.evaluate(
			() => !!document.querySelector('script[data-spool-client]')
		);
	} catch (e) {
		out.error = String(e).split('\n')[0];
	}
	await browser.close();
	return out;
}

const results = {};
const only = process.env.ONLY?.split(',') ?? Object.keys(types);
for (const type of only) {
	results[type] = [];
	for (let i = 0; i < N; i++) {
		const run = { i };
		run.spool = await arm('spool', type, true);
		run.control = await arm('control', type, false);
		run.spoolNoStore = await arm('spoolNoStore', type, true, true);
		run.controlNoStore = await arm('controlNoStore', type, false, true);
		run.kill = await kill(type, 86400);
		run.killNoCache = await kill(type, 0);
		results[type].push(run);
		console.log(type, i, JSON.stringify(run).length);
	}
}
await mode('kill=0&noclient=0&htmlStore=0&swAge=86400');
writeFileSync(process.env.OUT ?? 'results.json', JSON.stringify(results, null, '\t'));

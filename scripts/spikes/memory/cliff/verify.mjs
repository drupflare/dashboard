// counts only: prints success flags and how many entries start with the prefix, never names or ids
const token = process.env.CLOUDFLARE_API_TOKEN;
const acct = process.env.CLOUDFLARE_ACCOUNT_ID;
const prefix = process.argv[2] ?? 'spike-memory-v2';
const base = `https://api.cloudflare.com/client/v4/accounts/${acct}`;

async function get(path) {
	const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
	return res.json();
}

function matches(body) {
	const list = Array.isArray(body.result) ? body.result : [];
	const hit = (s) => typeof s === 'string' && s.startsWith(prefix);
	return {
		total: list.length,
		prefixMatches: list.filter((x) => [x.id, x.name, x.script, x.class].some(hit)).length
	};
}

const scripts = await get('/workers/scripts');
const namespaces = await get('/workers/durable_objects/namespaces');
const s = matches(scripts);
const n = matches(namespaces);
console.log(
	`workers scripts: success=${scripts.success} total=${s.total} prefix=${prefix} matches=${s.prefixMatches}`
);
console.log(
	`do namespaces: success=${namespaces.success} total=${n.total} prefix=${prefix} matches=${n.prefixMatches}`
);

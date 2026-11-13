// reads the durableObjectsPeriodicGroups rows for the probe script over a window, one row per returned group
import { appendFileSync, writeFileSync } from 'node:fs';

const [script, from, to] = process.argv.slice(2);
if (!script || !from || !to) throw new Error('usage: meter.mjs <script> <from ISO> <to ISO>');

const query = `{
  viewer {
    accounts(filter: { accountTag: "${process.env.CLOUDFLARE_ACCOUNT_ID}" }) {
      durableObjectsPeriodicGroups(
        limit: 10000
        filter: { name: "${script}", datetime_geq: "${from}", datetime_leq: "${to}" }
      ) {
        dimensions { datetimeMinute namespaceId objectId }
        count
        sum { cpuTime activeTime rowsRead rowsWritten exceededMemoryErrors }
        quantiles { memoryUsageBytesP50 memoryUsageBytesP90 memoryUsageBytesP99 memoryUsageBytesP999 }
      }
    }
  }
}`;

const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
	method: 'POST',
	headers: {
		authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
		'content-type': 'application/json'
	},
	body: JSON.stringify({ query })
});
const body = await res.json();
const out = new URL('./meter-rows.jsonl', import.meta.url);
writeFileSync(out, '');
if (body.errors?.length) {
	appendFileSync(
		out,
		JSON.stringify({
			op: 'error',
			http: res.status,
			messages: body.errors.map((e) => e.message)
		}) + '\n'
	);
	console.log(`meter query error: ${body.errors.map((e) => e.message).join(' | ')}`);
	process.exit(0);
}
const groups = body.data?.viewer?.accounts?.[0]?.durableObjectsPeriodicGroups ?? [];
for (const g of groups) appendFileSync(out, JSON.stringify({ op: 'group', ...g }) + '\n');
console.log(`meter groups returned: ${groups.length} (window ${from} to ${to})`);

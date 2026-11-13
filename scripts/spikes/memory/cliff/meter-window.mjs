// counts the durableObjectsPeriodicGroups rows in a window; pass "-" as the script to drop the name filter
const [script, from, to] = process.argv.slice(2);
if (!from || !to) throw new Error('usage: meter-window.mjs <script or -> <from ISO> <to ISO>');

const nameFilter = script && script !== '-' ? `name: "${script}", ` : '';
const query = `{
  viewer {
    accounts(filter: { accountTag: "${process.env.CLOUDFLARE_ACCOUNT_ID}" }) {
      durableObjectsPeriodicGroups(
        limit: 10000
        filter: { ${nameFilter}datetime_geq: "${from}", datetime_leq: "${to}" }
      ) {
        count
        sum { cpuTime activeTime rowsRead rowsWritten exceededMemoryErrors }
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
if (body.errors?.length) {
	console.log(
		`http ${res.status} errors: ${body.errors.map((e) => e.message.slice(0, 160)).join(' | ')}`
	);
	process.exit(0);
}
const groups = body.data?.viewer?.accounts?.[0]?.durableObjectsPeriodicGroups ?? [];
const events = groups.reduce((a, g) => a + (g.count ?? 0), 0);
console.log(
	`http ${res.status} groups ${groups.length} events ${events} filter ${script ?? '-'} window ${from} to ${to}`
);

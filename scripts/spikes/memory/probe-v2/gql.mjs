import { readFileSync } from 'node:fs';

const [file, varsJson] = process.argv.slice(2);
if (!file) throw new Error('usage: gql.mjs <query-file> [variables-json]');

const query = readFileSync(file, 'utf8');
const variables = {
	acct: process.env.CLOUDFLARE_ACCOUNT_ID,
	...(varsJson ? JSON.parse(varsJson) : {})
};

const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
	method: 'POST',
	headers: {
		authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
		'content-type': 'application/json'
	},
	body: JSON.stringify({ query, variables })
});
process.stdout.write(`http ${res.status}\n${await res.text()}\n`);

// mints a bucket scoped R2 token on the account in the environment, signs one put, get and delete
// with it, then removes the token and the bucket; prints statuses and timings, never a secret
const base = 'https://api.cloudflare.com/client/v4';
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const auth = { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN ?? ''}` };
// a user token (not cfat_) mints through /user/tokens, an account token through the account path
const tokens = (process.env.CLOUDFLARE_API_TOKEN ?? '').startsWith('cfat_')
	? `/accounts/${account}/tokens`
	: '/user/tokens';
const bucket = `drupflare-probe-${crypto.randomUUID().slice(0, 8)}`;
const GROUPS = ['Workers R2 Storage Bucket Item Read', 'Workers R2 Storage Bucket Item Write'];

const enc = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
	[...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
async function hmac(key: ArrayBuffer | string, text: string) {
	const raw = typeof key === 'string' ? enc.encode(key) : key;
	const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign'
	]);
	return crypto.subtle.sign('HMAC', k, enc.encode(text));
}

async function api(method: string, path: string, body?: unknown) {
	const started = performance.now();
	const response = await fetch(`${base}${path}`, {
		method,
		headers: { ...auth, 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const json = (await response.json().catch(() => ({}))) as {
		result?: any;
		errors?: { code: number; message: string }[];
	};
	return { status: response.status, json, ms: Math.round(performance.now() - started) };
}

async function s3(method: string, key: string, id: string, secret: string, body = '') {
	const host = `${account}.r2.cloudflarestorage.com`;
	const stamp = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
	const day = stamp.slice(0, 8);
	const payload = await sha256(body);
	const path = `/${bucket}/${key}`;
	const headers = `host:${host}\nx-amz-content-sha256:${payload}\nx-amz-date:${stamp}\n`;
	const signed = 'host;x-amz-content-sha256;x-amz-date';
	const canonical = [method, path, '', headers, signed, payload].join('\n');
	const scope = `${day}/auto/s3/aws4_request`;
	const toSign = ['AWS4-HMAC-SHA256', stamp, scope, await sha256(canonical)].join('\n');
	let k = await hmac(`AWS4${secret}`, day);
	for (const part of ['auto', 's3', 'aws4_request']) k = await hmac(k, part);
	const signature = hex(await hmac(k, toSign));
	const response = await fetch(`https://${host}${path}`, {
		method,
		headers: {
			'x-amz-date': stamp,
			'x-amz-content-sha256': payload,
			authorization: `AWS4-HMAC-SHA256 Credential=${id}/${scope}, SignedHeaders=${signed}, Signature=${signature}`
		},
		body: body === '' ? undefined : body
	});
	return { status: response.status, text: await response.text() };
}

const say = (label: string, value: unknown) => console.log(`${label}: ${JSON.stringify(value)}`);
let tokenId = '';
try {
	const groups = await api('GET', `${tokens}/permission_groups`);
	say('permission groups', { status: groups.status, ms: groups.ms });
	const wanted = (groups.json.result ?? []).filter((g: { name: string }) =>
		GROUPS.includes(g.name)
	);
	say(
		'matched groups',
		wanted.map((g: { name: string }) => g.name)
	);

	const made = await api('POST', `/accounts/${account}/r2/buckets`, { name: bucket });
	say('create bucket', { status: made.status, ms: made.ms, errors: made.json.errors });
	if (made.status !== 200) throw new Error('bucket not created');

	const minted = await api('POST', tokens, {
		name: `drupflare-probe-${bucket}`,
		policies: [
			{
				effect: 'allow',
				resources: { [`com.cloudflare.edge.r2.bucket.${account}_default_${bucket}`]: '*' },
				permission_groups: wanted.map((g: { id: string }) => ({ id: g.id }))
			}
		]
	});
	say('mint token', { status: minted.status, ms: minted.ms, errors: minted.json.errors });
	if (minted.status !== 200) throw new Error('token not minted');
	tokenId = minted.json.result.id;
	const secret = await sha256(minted.json.result.value);

	const t0 = performance.now();
	let put = await s3('PUT', 'probe.txt', tokenId, secret, 'hello');
	while (put.status !== 200 && performance.now() - t0 < 60_000) {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		put = await s3('PUT', 'probe.txt', tokenId, secret, 'hello');
	}
	say('first put', { status: put.status, waitedMs: Math.round(performance.now() - t0) });
	const get = await s3('GET', 'probe.txt', tokenId, secret);
	say('get', { status: get.status, body: get.text });
	const del = await s3('DELETE', 'probe.txt', tokenId, secret);
	say('delete object', { status: del.status });
} finally {
	if (tokenId !== '') {
		const gone = await api('DELETE', `${tokens}/${tokenId}`);
		say('delete token', { status: gone.status });
	}
	const removed = await api('DELETE', `/accounts/${account}/r2/buckets/${bucket}`);
	say('delete bucket', { status: removed.status, errors: removed.json.errors });
}

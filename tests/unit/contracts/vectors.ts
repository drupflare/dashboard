import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { omitSig, signingInput } from '../../../contracts/src/common';
import { verifyChallengeResponse, verifyEnvelope } from '../../../contracts/src/fleet-link';
import { verifyAssertion } from '../../../contracts/src/owner-assertion';
import { checkLease } from '../../../contracts/src/site-auth';

type Json = Record<string, any>;
type Case = {
	name: string;
	kind: 'envelope' | 'challenge' | 'lease' | 'assertion';
	description: string;
	input: any;
	context: Json;
	signingInput?: string;
	expectServing?: string;
	expect: string;
};
export type VectorFile = {
	contract: string;
	version: string;
	signingContexts: Record<string, string>;
	keys: Record<string, { note: string; seed: string; publicKey: string }>;
	positive: Case[];
	negative: Case[];
};

export function loadVectors(name: string): VectorFile {
	const url = new URL(`../../../contracts/vectors/${name}.json`, import.meta.url);
	return JSON.parse(readFileSync(url, 'utf8')) as VectorFile;
}

async function run(c: Case): Promise<{ ok: boolean; code?: string; serving?: string }> {
	const seen = new Set<string>(c.context.seen ?? []);
	if (c.kind === 'envelope') {
		const result = await verifyEnvelope(c.input, { ...(c.context as any), seen });
		return result.ok ? { ok: true } : result;
	}
	if (c.kind === 'challenge') {
		const result = await verifyChallengeResponse(c.input, c.context as any);
		return result.ok ? { ok: true } : result;
	}
	if (c.kind === 'lease') {
		const result = await checkLease(c.input, c.context as any);
		return result.ok ? { ok: true, serving: result.value.serving } : result;
	}
	const result = await verifyAssertion(c.input, { ...(c.context as any), seen });
	return result.ok ? { ok: true } : result;
}

export function vectorTests(file: string, signingContexts: Record<string, string>): void {
	const vectors = loadVectors(file);
	describe(`${file} vectors`, () => {
		it('labels every key as a test key', () => {
			for (const key of Object.values(vectors.keys))
				expect(key.note).toMatch(/^TEST KEY ONLY/);
		});

		for (const c of vectors.positive) {
			it(`verifies ${c.name}`, async () => {
				const result = await run(c);
				expect(result.ok).toBe(true);
				if (c.expectServing) expect(result.serving).toBe(c.expectServing);
				if (c.signingInput) {
					const context = signingContexts[c.kind]!;
					expect(c.signingInput).toBe(signingInput(context, omitSig(c.input)));
				}
			});
		}

		for (const c of vectors.negative) {
			it(`refuses ${c.name} with ${c.expect}`, async () => {
				const result = await run(c);
				expect(result.ok).toBe(false);
				expect(result.code).toBe(c.expect);
			});
		}

		it('keeps negative names unique', () => {
			const names = vectors.negative.map((c) => c.name);
			expect(new Set(names).size).toBe(names.length);
		});
	});
}

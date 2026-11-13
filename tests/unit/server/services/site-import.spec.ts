import { describe, expect, it } from 'vitest';
import {
	checkImportHost,
	importHostSchema,
	importRootSchema
} from '../../../../src/server/services/site-import';

const resolveTo =
	(...addresses: string[]) =>
	async () =>
		addresses;

const refusalOf = async (promise: Promise<unknown>) =>
	(await promise.then(
		() => null,
		(error: unknown) => error
	)) as { details?: { reason?: string } } | null;

describe('checkImportHost', () => {
	it('returns the address to dial: a public literal as it is, a name as its first public address', async () => {
		await expect(checkImportHost('93.184.216.34', resolveTo())).resolves.toBe('93.184.216.34');
		await expect(
			checkImportHost('server.example.test', resolveTo('93.184.216.35', '2606:4700::1111'))
		).resolves.toBe('93.184.216.35');
	});

	it('answers differently on a second lookup, so every connection has to check again', async () => {
		let calls = 0;
		const resolve = async () => (++calls === 1 ? ['93.184.216.34'] : ['10.0.0.5']);
		await expect(checkImportHost('rebind.example.test', resolve)).resolves.toBe(
			'93.184.216.34'
		);
		expect(await refusalOf(checkImportHost('rebind.example.test', resolve))).toMatchObject({
			details: { reason: 'host_private' }
		});
	});

	it.each(['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1'])(
		'refuses the private literal %s',
		async (host) => {
			expect(await refusalOf(checkImportHost(host, resolveTo()))).toMatchObject({
				details: { reason: 'host_private' }
			});
		}
	);

	it.each(['db.internal', 'box.local', 'x.localhost', 'a.localdomain'])(
		'refuses the private suffix of %s without a lookup',
		async (host) => {
			let looked = false;
			const resolve = async () => {
				looked = true;
				return ['93.184.216.34'];
			};
			expect(await refusalOf(checkImportHost(host, resolve))).toMatchObject({
				details: { reason: 'host_private' }
			});
			expect(looked).toBe(false);
		}
	);

	it('refuses a name that resolves to one private address among public ones', async () => {
		expect(
			await refusalOf(
				checkImportHost('mixed.example.test', resolveTo('93.184.216.34', '10.0.0.9'))
			)
		).toMatchObject({ details: { reason: 'host_private' } });
	});

	it('refuses a name that does not resolve, and one whose lookup fails', async () => {
		expect(await refusalOf(checkImportHost('none.example.test', resolveTo()))).toMatchObject({
			details: { reason: 'host_unresolved' }
		});
		const broken = async () => {
			throw new Error('dns down');
		};
		expect(await refusalOf(checkImportHost('x.example.test', broken))).toMatchObject({
			details: { reason: 'host_unresolved' }
		});
	});
});

describe('the host and path schemas', () => {
	it('accepts names and addresses and refuses anything with spaces or shell characters', () => {
		for (const host of ['a.example.test', '93.184.216.34', '2606:4700::1111']) {
			expect(importHostSchema.safeParse(host).success, host).toBe(true);
		}
		for (const host of ['', 'a b', 'a;b.example', 'single', '$(id).example', 'a.example/x']) {
			expect(importHostSchema.safeParse(host).success, host).toBe(false);
		}
	});

	it('accepts an absolute path of plain characters and refuses a climb or a quote', () => {
		for (const root of ['/', '/var/www/html', '/srv/site_1/web-root', '/home/u/public.html']) {
			expect(importRootSchema.safeParse(root).success, root).toBe(true);
		}
		for (const root of ['relative', '/a/../b', "/it's", '/a b', '/a;b', '/a$b', '/a`b']) {
			expect(importRootSchema.safeParse(root).success, root).toBe(false);
		}
	});
});

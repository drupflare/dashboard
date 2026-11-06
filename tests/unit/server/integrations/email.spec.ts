import { describe, expect, it } from 'vitest';
import type { RenderedMail } from '../../../../src/server/emails';
import {
	classifyMailError,
	cloudflareEmailSender,
	handleMailBatch,
	MailDeliveryError,
	type EmailBinding,
	type MailJob,
	type MailSender,
	type QueuedMessage
} from '../../../../src/server/integrations/email';

const mail: RenderedMail = {
	category: 'login-code',
	subject: 'Your sign-in code',
	text: 'Your code is 483920.',
	html: '<p>Your code is 483920.</p>',
	headers: {}
};

const job: MailJob = { to: 'person@example.test', mail };
const from = { email: 'no-reply@mail.example.test', name: 'Drupflare' };

function fakeBinding(failure?: unknown): EmailBinding & { sent: unknown[] } {
	const sent: unknown[] = [];
	return {
		sent,
		async send(message) {
			sent.push(message);
			if (failure !== undefined) throw failure;
			return { messageId: 'msg_1' };
		}
	};
}

function fakeSender(failures: unknown[] = []): MailSender & { sent: string[] } {
	const sent: string[] = [];
	return {
		sent,
		async send(to) {
			sent.push(to);
			const failure = failures.shift();
			if (failure !== undefined) throw failure;
		}
	};
}

function message(body: MailJob, attempts: number) {
	const record = { acked: 0, retried: [] as (number | undefined)[] };
	const queued: QueuedMessage<MailJob> & typeof record = {
		body,
		attempts,
		...record,
		ack() {
			this.acked += 1;
		},
		retry(options) {
			this.retried.push(options?.delaySeconds);
		}
	};
	return queued;
}

describe('classifyMailError', () => {
	it('treats rate limits and server errors as retryable', () => {
		expect(classifyMailError({ status: 429 }).retryable).toBe(true);
		expect(classifyMailError({ status: 503 }).retryable).toBe(true);
	});

	it('treats other client errors as permanent', () => {
		expect(classifyMailError({ status: 422 }).retryable).toBe(false);
	});

	it('treats a failure with no status as retryable', () => {
		const error = classifyMailError(new Error('socket reset'));
		expect(error).toBeInstanceOf(MailDeliveryError);
		expect(error.retryable).toBe(true);
	});
});

describe('cloudflareEmailSender', () => {
	it('passes the rendered message and the list headers to the binding', async () => {
		const binding = fakeBinding();
		const sender = cloudflareEmailSender(binding, from);
		await sender.send('person@example.test', { ...mail, headers: { 'X-Test': '1' } });
		expect(binding.sent).toEqual([
			{
				to: 'person@example.test',
				from,
				subject: mail.subject,
				text: mail.text,
				html: mail.html,
				headers: { 'X-Test': '1' }
			}
		]);
	});

	it('maps a provider failure to a MailDeliveryError', async () => {
		const sender = cloudflareEmailSender(fakeBinding({ status: 422 }), from);
		const error = await sender.send('person@example.test', mail).catch((caught) => caught);
		expect(error).toBeInstanceOf(MailDeliveryError);
		expect(error.retryable).toBe(false);
	});
});

describe('handleMailBatch', () => {
	it('acks a delivered message', async () => {
		const sender = fakeSender();
		const queued = message(job, 1);
		await handleMailBatch({ messages: [queued] }, { sender, maxAttempts: 3 });
		expect(queued.acked).toBe(1);
		expect(queued.retried).toEqual([]);
		expect(sender.sent).toEqual([job.to]);
	});

	it('retries a retryable failure below the attempt bound', async () => {
		const sender = fakeSender([new MailDeliveryError(true, 'busy')]);
		const queued = message(job, 2);
		await handleMailBatch(
			{ messages: [queued] },
			{ sender, maxAttempts: 3, retryDelaySeconds: 30 }
		);
		expect(queued.retried).toEqual([30]);
		expect(queued.acked).toBe(0);
	});

	it('acks a retryable failure once the attempt bound is reached', async () => {
		const sender = fakeSender([new MailDeliveryError(true, 'busy')]);
		const queued = message(job, 3);
		await handleMailBatch({ messages: [queued] }, { sender, maxAttempts: 3 });
		expect(queued.retried).toEqual([]);
		expect(queued.acked).toBe(1);
	});

	it('acks a permanent failure without a retry', async () => {
		const sender = fakeSender([new MailDeliveryError(false, 'bad recipient')]);
		const queued = message(job, 1);
		await handleMailBatch({ messages: [queued] }, { sender, maxAttempts: 3 });
		expect(queued.retried).toEqual([]);
		expect(queued.acked).toBe(1);
	});

	it('treats an unexpected error as retryable within the bound', async () => {
		const sender = fakeSender([new Error('unexpected')]);
		const queued = message(job, 1);
		await handleMailBatch({ messages: [queued] }, { sender, maxAttempts: 3 });
		expect(queued.retried).toEqual([undefined]);
	});

	it('handles each message in the batch on its own', async () => {
		const sender = fakeSender([new MailDeliveryError(false, 'bad recipient')]);
		const first = message(job, 1);
		const second = message(job, 1);
		await handleMailBatch({ messages: [first, second] }, { sender, maxAttempts: 3 });
		expect(first.acked).toBe(1);
		expect(second.acked).toBe(1);
		expect(sender.sent).toHaveLength(2);
	});
});

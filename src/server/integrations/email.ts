import type { RenderedMail } from '../emails';

// #region sender

export interface MailSender {
	send(to: string, mail: RenderedMail): Promise<void>;
}

export class MailDeliveryError extends Error {
	readonly retryable: boolean;

	constructor(retryable: boolean, message: string) {
		super(message);
		this.name = 'MailDeliveryError';
		this.retryable = retryable;
	}
}

// the shape of the send_email binding is unverified against the live docs; check it before a live send
export interface EmailBinding {
	send(message: {
		to: string;
		from: { email: string; name: string };
		subject: string;
		text: string;
		html: string;
		headers: Record<string, string>;
	}): Promise<unknown>;
}

// a status of 429 or 5xx, or no status at all, is retryable; any other status is permanent
export function classifyMailError(error: unknown): MailDeliveryError {
	if (error instanceof MailDeliveryError) return error;
	const status =
		typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
	const message = error instanceof Error ? error.message : 'mail delivery failed';
	const retryable = typeof status !== 'number' || status === 429 || status >= 500;
	return new MailDeliveryError(retryable, message);
}

export function cloudflareEmailSender(
	binding: EmailBinding,
	from: { email: string; name: string }
): MailSender {
	return {
		async send(to, mail) {
			try {
				await binding.send({
					to,
					from,
					subject: mail.subject,
					text: mail.text,
					html: mail.html,
					headers: mail.headers
				});
			} catch (error) {
				throw classifyMailError(error);
			}
		}
	};
}

// #endregion

// #region queue

export interface MailJob {
	to: string;
	mail: RenderedMail;
}

export interface QueuedMessage<T> {
	readonly body: T;
	readonly attempts: number;
	ack(): void;
	retry(options?: { delaySeconds?: number }): void;
}

export interface MailBatchDeps {
	sender: MailSender;
	maxAttempts: number;
	retryDelaySeconds?: number;
}

// an exhausted retryable message is acked and lost; there is no dead-letter queue yet
export async function handleMailBatch(
	batch: { messages: readonly QueuedMessage<MailJob>[] },
	deps: MailBatchDeps
): Promise<void> {
	await Promise.all(
		batch.messages.map(async (message) => {
			try {
				await deps.sender.send(message.body.to, message.body.mail);
				message.ack();
			} catch (error) {
				const failure = classifyMailError(error);
				if (failure.retryable && message.attempts < deps.maxAttempts) {
					message.retry({ delaySeconds: deps.retryDelaySeconds });
				} else {
					message.ack();
				}
			}
		})
	);
}

// #endregion

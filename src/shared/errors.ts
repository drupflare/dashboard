export const ERROR_STATUS = {
	validation: 400,
	unauthenticated: 401,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	precondition_failed: 412,
	unprocessable: 422,
	contract_unsupported: 426,
	rate_limited: 429,
	not_built: 501,
	internal: 500
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class ApiError extends Error {
	readonly code: ErrorCode;
	readonly status: number;
	readonly details: unknown;

	constructor(code: ErrorCode, message: string, details: unknown = null) {
		super(message);
		this.name = 'ApiError';
		this.code = code;
		this.status = ERROR_STATUS[code];
		this.details = details;
	}
}

export type ErrorBody = {
	code: ErrorCode;
	message: string;
	details: unknown;
	requestId: string;
};

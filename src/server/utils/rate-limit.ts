export const ROUTE_CLASSES = ['auth-code', 'read', 'write', 'heavy', 'webhook'] as const;

export type RouteClass = (typeof ROUTE_CLASSES)[number];

// a route names one of the route classes; the limiter also keeps the address ceiling that sits
// behind the auth-code class
export const LIMIT_CLASSES = [...ROUTE_CLASSES, 'auth-code-ip'] as const;

export type LimitClass = (typeof LIMIT_CLASSES)[number];

export type RateRule = { limit: number; windowMs: number };

export type RateConfig = Record<LimitClass, RateRule>;

export type RateDecision = {
	allowed: boolean;
	limit: number;
	remaining: number;
	resetSeconds: number;
	retryAfterSeconds: number;
	timestamps: number[];
};

// a request stays counted until windowMs after it was made, so the slot frees at exact expiry
export function slideWindow(timestamps: number[], now: number, rule: RateRule): RateDecision {
	const live = timestamps.filter((time) => now - time < rule.windowMs);
	const allowed = live.length < rule.limit;
	const kept = allowed ? [...live, now] : live;
	const oldest = kept.reduce((min, time) => Math.min(min, time), Infinity);
	const untilFree = kept.length === 0 ? 0 : oldest + rule.windowMs - now;
	return {
		allowed,
		limit: rule.limit,
		remaining: rule.limit - kept.length,
		resetSeconds: Math.ceil(untilFree / 1000),
		retryAfterSeconds: allowed ? 0 : Math.ceil(untilFree / 1000),
		timestamps: kept
	};
}

export function rateLimitHeaders(decision: RateDecision): Record<string, string> {
	const headers: Record<string, string> = {
		'RateLimit-Limit': String(decision.limit),
		'RateLimit-Remaining': String(decision.remaining),
		'RateLimit-Reset': String(decision.resetSeconds)
	};
	if (!decision.allowed) headers['Retry-After'] = String(decision.retryAfterSeconds);
	return headers;
}

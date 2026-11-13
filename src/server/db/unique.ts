export function isUniqueViolation(error: unknown): boolean {
	return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}

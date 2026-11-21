// a text cell that starts with a spreadsheet formula character gets a leading apostrophe
const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null): string {
	if (value === null) return '';
	if (typeof value === 'number') return String(value);
	const guarded = FORMULA.test(value) ? `'${value}` : value;
	return /[",\n\r]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

export function csvLines(rows: readonly (readonly (string | number | null)[])[]): string {
	return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

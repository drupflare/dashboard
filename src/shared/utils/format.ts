const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

const DURATION_UNITS: [number, string][] = [
	[86_400, 'd'],
	[3_600, 'h'],
	[60, 'm'],
	[1, 's']
];

export function formatBytes(bytes: number): string {
	if (!Number.isSafeInteger(bytes) || bytes < 0) {
		throw new RangeError('bytes must be a non-negative integer');
	}
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${Number(value.toFixed(1))} ${BYTE_UNITS[unit]}`;
}

export function formatDuration(ms: number): string {
	if (!Number.isSafeInteger(ms) || ms < 0) {
		throw new RangeError('ms must be a non-negative integer');
	}
	if (ms < 1000) return `${ms}ms`;
	let seconds = Math.floor(ms / 1000);
	const parts: string[] = [];
	for (const [size, label] of DURATION_UNITS) {
		const count = Math.floor(seconds / size);
		seconds -= count * size;
		if (count > 0) parts.push(`${count}${label}`);
	}
	return parts.join(' ');
}

// amounts stay integer cents; the decimal string goes to Intl as text so no float is ever built
export function formatMoney(cents: number, currency: string): string {
	if (!Number.isSafeInteger(cents)) throw new RangeError('money must be integer cents');
	const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency });
	const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
	const scale = 10n ** BigInt(digits);
	const magnitude = BigInt(Math.abs(cents));
	const whole = magnitude / scale;
	const fraction = (magnitude % scale).toString().padStart(digits, '0');
	const sign = cents < 0 ? '-' : '';
	const amount = digits > 0 ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
	return formatter.format(amount as `${number}`);
}

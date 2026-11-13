const QUOTE = 39;
const BACKTICK = 96;
const BACKSLASH = 92;
const SEMICOLON = 59;
const NEWLINE = 10;
const DASH = 45;
const TAIL_BYTES = 256;

const END_LINE = /^-- end, (\d+) statements?$/;
const COUNTED = /^(?:REPLACE INTO|DELETE FROM) /;

export interface ChangeScanResult {
	// REPLACE and DELETE statements read
	statements: number;
	// the count the closing line declared, null when the body has no closing line
	declared: number | null;
	// the closing line is there and agrees with what was read
	complete: boolean;
}

// reads a change list as it streams and never holds it. A string literal can span lines, so a
// statement ends at a semicolon outside quotes and not at a line end
export class ChangeScan {
	private quote = 0;
	private escaped = false;
	private comment = false;
	private dash = false;
	private head = '';
	private inStatement = false;
	private statements = 0;
	private tail = '';

	push(bytes: Uint8Array): void {
		for (const byte of bytes) this.step(byte);
		const last = bytes.subarray(Math.max(0, bytes.byteLength - TAIL_BYTES));
		this.tail = (this.tail + String.fromCharCode(...last)).slice(-TAIL_BYTES);
	}

	private step(byte: number): void {
		if (this.comment) {
			if (byte === NEWLINE) this.comment = false;
			return;
		}
		if (!this.inStatement) {
			if (byte === 32 || byte === 9 || byte === 13 || byte === NEWLINE) return;
			if (byte === DASH && this.dash) {
				this.dash = false;
				this.comment = true;
				return;
			}
			if (byte === DASH) {
				this.dash = true;
				return;
			}
			this.dash = false;
			this.inStatement = true;
			this.head = '';
		}
		if (this.head.length < 14) this.head += String.fromCharCode(byte);
		if (this.quote !== 0) {
			if (this.escaped) this.escaped = false;
			else if (byte === BACKSLASH && this.quote === QUOTE) this.escaped = true;
			else if (byte === this.quote) this.quote = 0;
			return;
		}
		if (byte === QUOTE || byte === BACKTICK) this.quote = byte;
		else if (byte === SEMICOLON) {
			if (COUNTED.test(this.head)) this.statements++;
			this.inStatement = false;
		}
	}

	result(): ChangeScanResult {
		const lines = this.tail.trimEnd().split('\n');
		const found = END_LINE.exec(lines[lines.length - 1] ?? '');
		const declared = found === null ? null : Number(found[1]);
		const clean = this.quote === 0 && !this.inStatement;
		return {
			statements: this.statements,
			declared,
			complete: clean && declared !== null && declared === this.statements
		};
	}
}

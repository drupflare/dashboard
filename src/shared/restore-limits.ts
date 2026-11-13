const MIB = 1024 * 1024;

// the most one POST /restore body carries, the worker's MAX_RESTORE_BYTES default
export const SINGLE_RESTORE_BYTES = 16 * MIB;

// the most a whole dump carries through the paged restore, the worker's MAX_RESTORE_PAGED_BYTES default
export const MAX_RESTORE_PAGED_BYTES = 128 * MIB;

// the most one part carries; the worker refuses a part above this
export const RESTORE_PART_BYTES = 1 * MIB;

// the most the file rows add to one import, because the engine turns them into statements in memory
export const FILES_BODY_BYTES = SINGLE_RESTORE_BYTES;

export const restoreCeiling = (paged: boolean) =>
	paged ? MAX_RESTORE_PAGED_BYTES : SINGLE_RESTORE_BYTES;

export const mebibytes = (bytes: number) => Math.floor(bytes / MIB);

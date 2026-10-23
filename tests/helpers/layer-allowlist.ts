// The layer fence's ratchet. Every entry is a known violation the
// refactor has not cut yet. tests/layers.test.ts fails on a violation missing
// from these lists AND on an entry that no longer occurs, so the lists only
// ever shrink. Both are empty when the refactor is done.

/** Runtime edges pointing up the layers, as `from -> to`. */
export const UPWARD_EDGES_ALLOWED: readonly string[] = [];

/** Forbidden process calls in core, as `file: name`. */
export const CORE_FORBIDDEN_ALLOWED: readonly string[] = [];

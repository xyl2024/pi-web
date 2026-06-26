/**
 * Deep content-equality comparator. Two values are considered equal when
 * their visible content matches, even if they have different references.
 *
 * Used by the module stores (sessionUiStore / toolCallStatsStore / httpStore)
 * to avoid spurious re-renders when an upstream hook recomputes a fresh
 * object on every render whose contents are identical to the previous one.
 *
 * Supports: primitives, plain objects, arrays, Maps, Dates, null, undefined.
 * Anything else (class instances, Sets, RegExp, …) falls back to reference
 * equality via the `a === b` short-circuit at the top.
 */
export function isContentEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;

  if (a instanceof Date || b instanceof Date) {
    if (!(a instanceof Date) || !(b instanceof Date)) return false;
    return a.getTime() === b.getTime();
  }

  const aIsMap = a instanceof Map;
  const bIsMap = b instanceof Map;
  if (aIsMap !== bIsMap) return false;
  if (aIsMap && bIsMap) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!isContentEqual(v, b.get(k))) return false;
    }
    return true;
  }

  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr !== bIsArr) return false;
  if (aIsArr && bIsArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isContentEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!isContentEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}
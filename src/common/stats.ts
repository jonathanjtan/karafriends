// Shared statistics helpers used by vocal-range measurement and the piano
// roll's note layout.

// The ordinary median: the middle value of a sorted list, or the average of
// the two middle values when the count is even. NaN on an empty input, since
// there is no midpoint to report.
//
// The comparator is required: Array.prototype.sort defaults to lexicographic
// ordering, which only agrees with numeric ordering for single-digit values.
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

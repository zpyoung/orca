/**
 * Binary search for the smallest oldest-first omission prefix that makes a projection fit its byte
 * budget. Shared by the judgment feature's state bounder and the owner brief's bounder so the
 * oldest-history-first search is written once. `project` must be monotone: dropping a longer prefix
 * never makes a fit projection stop fitting.
 */
export function searchMinimalOmissionPrefix<T extends { fitsStateBudget: boolean }>(
  unitCount: number,
  project: (prefix: number) => T
): { prefix: number; result: T } | null {
  if (unitCount === 0) {
    return null
  }
  const maximum = project(unitCount)
  if (!maximum.fitsStateBudget) {
    return { prefix: unitCount, result: maximum }
  }
  let low = 1
  let high = unitCount
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (project(middle).fitsStateBudget) {
      high = middle
    } else {
      low = middle + 1
    }
  }
  return low === unitCount
    ? { prefix: unitCount, result: maximum }
    : { prefix: low, result: project(low) }
}

/* oxlint-disable react-doctor/no-ref-current-in-render -- Why: the render-phase write is the identity cache itself; deferring it to an effect would hand callers a stale array. */
import { useRef } from 'react'
import { reuseArrayIfEqual } from '../worktree-agent-row-selectors'

// Why: epoch-driven recomputes often produce arrays whose contents and order are unchanged; reusing the previous identity when element-wise equal keeps downstream memos and React.memo'd cards bailing out. Safe only because elements (Worktree objects / id strings) are immutably REPLACED on change — never wrap arrays of mutated-in-place objects.
export function useReusedArrayIdentity<T>(next: T[]): T[] {
  const previousRef = useRef<T[]>(next)
  const result = reuseArrayIfEqual(previousRef.current, next)
  previousRef.current = result
  return result
}

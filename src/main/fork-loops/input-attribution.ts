export const LOOP_WRITE_ATTRIBUTION_SLACK_MS = 1500
export const LOOP_USER_IDLE_MS = 20000

// a write whose settle note never arrives must not swallow the user's typing forever
const LOOP_WRITE_OPEN_WINDOW_MAX_MS = 60000
const RETAINED_WINDOWS_PER_PTY = 8

export type InputAttributionRuntime = {
  terminalRunFacts?: { readLastInputAt?: (ptyId: string) => number | null }
}

export type InputAttribution = {
  /**
   * Records one edge of the loop's own prompt write. Call it when the write starts
   * (`onInputAccepted`) and again when it settles (`afterWrite`); the two calls bound the window
   * in which `readLastInputAt` moving is the loop's doing rather than the user's.
   */
  noteLoopWrite(ptyId: string, at: number): void
  /** Whether the user, not the loop, typed into the PTY at or after `since`. */
  userInputSince(ptyId: string, since: number): boolean
  /** Whether the user has been silent for at least `ms`; true when no user input is known. */
  userIdleFor(ptyId: string, ms: number): boolean
}

type WriteWindow = { start: number; end: number | null }

type PtyAttribution = {
  windows: WriteWindow[]
  lastSeenInputAt: number | null
  lastUserInputAt: number | null
}

/**
 * Separates the user's keystrokes from the loop's own prompt writes without touching the PTY write
 * path: `readLastInputAt` is sampled lazily and each new value is classified against the write
 * windows the loop reported. Every dependency is optional so attribution never throws.
 */
export function createInputAttribution(
  runtime: InputAttributionRuntime,
  deps: { now?: () => number } = {}
): InputAttribution {
  const now = deps.now ?? Date.now
  const byPty = new Map<string, PtyAttribution>()

  const stateFor = (ptyId: string): PtyAttribution => {
    let state = byPty.get(ptyId)
    if (!state) {
      state = { windows: [], lastSeenInputAt: null, lastUserInputAt: null }
      byPty.set(ptyId, state)
    }
    return state
  }

  const readLastInputAt = (ptyId: string): number | null => {
    try {
      const facts = runtime.terminalRunFacts
      if (!facts || typeof facts.readLastInputAt !== 'function') {
        return null
      }
      return facts.readLastInputAt(ptyId)
    } catch {
      return null
    }
  }

  const isLoopInput = (state: PtyAttribution, at: number, sampledAt: number): boolean =>
    state.windows.some((window) => {
      const end =
        window.end === null
          ? sampledAt - window.start < LOOP_WRITE_OPEN_WINDOW_MAX_MS
            ? Number.POSITIVE_INFINITY
            : window.start
          : window.end + LOOP_WRITE_ATTRIBUTION_SLACK_MS
      return at >= window.start && at <= end
    })

  const sample = (ptyId: string): PtyAttribution => {
    const state = stateFor(ptyId)
    const lastInputAt = readLastInputAt(ptyId)
    if (lastInputAt !== null && lastInputAt !== state.lastSeenInputAt) {
      state.lastSeenInputAt = lastInputAt
      if (!isLoopInput(state, lastInputAt, now())) {
        state.lastUserInputAt = lastInputAt
      }
    }
    return state
  }

  return {
    noteLoopWrite(ptyId, at) {
      // the single input slot is about to be overwritten by the loop, so bank the user's value first
      const state = sample(ptyId)
      const open = state.windows.at(-1)
      if (open && open.end === null) {
        open.end = Math.max(at, open.start)
      } else {
        state.windows.push({ start: at, end: null })
        if (state.windows.length > RETAINED_WINDOWS_PER_PTY) {
          state.windows.shift()
        }
      }
    },
    userInputSince(ptyId, since) {
      const { lastUserInputAt } = sample(ptyId)
      return lastUserInputAt !== null && lastUserInputAt >= since
    },
    userIdleFor(ptyId, ms) {
      const { lastUserInputAt } = sample(ptyId)
      return lastUserInputAt === null || now() - lastUserInputAt >= ms
    }
  }
}

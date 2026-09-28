import type { RuntimePtyWorktreeRecord } from '../../runtime/runtime-terminal-state-records'
import { redactWorkerTerminalLines } from '../../runtime/orchestration/worker-transcript-payload'
import { buildPreview } from '../../runtime/terminal-tail-state'

// Capture only this PTY's retained output; never query or fall back across execution hosts.
export function captureWorkerExitTail(
  pty: RuntimePtyWorktreeRecord | null | undefined
): string | null {
  // Why the buffer check: upstream onPtyExit suites register partial records with no tail state.
  if (!pty || !Array.isArray(pty.tailBuffer)) {
    return null
  }

  // Redact before clipping so a truncated capability cannot evade the full-token redactor.
  const completedLines = redactWorkerTerminalLines(pty.tailBuffer).lines
  const partialLine = redactWorkerTerminalLines([pty.tailPartialLine ?? '']).lines[0] ?? ''
  const preview = buildPreview(completedLines, partialLine)
  return preview ? `\n\nLast terminal output:\n${preview}` : null
}

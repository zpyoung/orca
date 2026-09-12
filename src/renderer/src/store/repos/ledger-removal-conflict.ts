// Electron IPC strips custom error properties, so the code also arrives prefixed onto the message.
export function isLedgerRemovalConflict(error: unknown): boolean {
  return (
    (error as { code?: string } | null)?.code === 'conflict' ||
    (error instanceof Error && error.message.includes('conflict'))
  )
}

import type { OrcaRuntimeService } from '../orca-runtime'

const PTY_ID_WAIT_TIMEOUT_MS = 5_000

/**
 * The only accepted confirmation a stage-C retry may act on: `stopAndWait` returning `true`.
 * A pty that already dropped out of the live registry, or whose controller lacks the method,
 * can still have a surviving process the kill path left running — so both cases resolve to
 * "unconfirmed", never to a false "stopped".
 */
export async function verifyPtyStopped(
  runtime: OrcaRuntimeService,
  args: { worktreeId: string; terminalHandle: string }
): Promise<boolean> {
  let ptyId: string
  try {
    ptyId = await runtime.waitForLeafPtyId(args.terminalHandle, PTY_ID_WAIT_TIMEOUT_MS)
  } catch {
    return false
  }

  try {
    const result = await runtime.stopExactTerminalsForWorktree(`id:${args.worktreeId}`, [ptyId], {
      targetOnly: true
    })
    return result.postStopVerified === true
  } catch {
    return false
  }
}

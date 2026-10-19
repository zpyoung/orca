import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { PtyRendererDelivery } from '../session'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { isPtyWriteUnavailableError } from '../../../providers/pty-write-unavailable-error'
import {
  isTerminalInputTooLargeWithDeferredMeasurement,
  iterateTerminalInputChunks,
  splitTerminalInputChunks
} from '../../../../shared/terminal-input'
import { ptyOwnership } from '../provider/ownership-state'
import { tryGetProviderForPty } from '../provider/registry'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'
import { interactiveOutputCharsByPty, lastInputAtByPty } from '../delivery/visibility-state'
import { isSettledWrite, type WriteSettlement } from '../../../../shared/pty-write-settlement'

export function isMainWindowPtyIpcEvent(
  event: IpcMainEvent | IpcMainInvokeEvent,
  mainWindow: PtyRendererDelivery | undefined
): boolean {
  const mainWebContents = mainWindow?.webContents
  return (
    !!mainWindow &&
    !!mainWebContents &&
    event.sender === mainWebContents &&
    !mainWindow.isDestroyed() &&
    !(typeof mainWebContents.isDestroyed === 'function' && mainWebContents.isDestroyed())
  )
}

export type PtyWritePayload = {
  id: string
  data: string
  inputKind: TerminalInputKind
  /** Accepted-write callers only: wait for the provider's settlement, on any provider. */
  requireWriteSettlement?: true
}
export type PtyViewportClaimPayload = { id: string; cols: number; rows: number }

export function createPtyWriteInput(deps: {
  mainWindow?: PtyRendererDelivery
  runtime?: OrcaRuntimeService
}): {
  writePtyInput: (args: PtyWritePayload) => boolean | Promise<boolean>
  writePtyInputAccepted: (args: PtyWritePayload) => boolean | Promise<boolean>
  writePtyInputProvablyLive: (args: PtyWritePayload) => boolean | Promise<boolean>
  isPtyWritePayload: (value: unknown) => value is PtyWritePayload
  isPtyViewportClaimPayload: (value: unknown) => value is PtyViewportClaimPayload
  isPtyWriteEventFromMainWindow: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean
} {
  const { mainWindow, runtime } = deps

  const sendPtyWriteUnavailable = (id: string): void => {
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      (typeof mainWindow.webContents.isDestroyed === 'function' &&
        mainWindow.webContents.isDestroyed())
    ) {
      return
    }
    mainWindow.webContents.send('pty:writeUnavailable', { id })
  }

  const reportUnavailablePtyWrite = (id: string, error: unknown): void => {
    if (isPtyWriteUnavailableError(error)) {
      sendPtyWriteUnavailable(id)
    }
  }

  const writePtyProviderInputWithinLimit = (
    provider: IPtyProvider,
    id: string,
    data: string,
    verify = false
  ): boolean | Promise<boolean> => {
    const chunks = iterateTerminalInputChunks(data)
    const first = chunks.next()
    if (first.done) {
      return writeChunk(provider, id, data, verify)
    }
    const second = chunks.next()
    if (second.done) {
      return writeChunk(provider, id, first.value, verify)
    }
    return writePtyProviderInputChunks(provider, id, chunks, first.value, second.value, verify)
  }

  const acceptedSettlement = (id: string, settlement: WriteSettlement): boolean => {
    if (settlement.outcome === 'unverifiable') {
      // A lost acknowledgment must not trigger a fallback write of the same bytes.
      throw new Error(`PTY write acknowledgment unavailable: ${settlement.reason}`)
    }
    if (settlement.outcome === 'refused' && settlement.reason === 'endpoint_awaiting_recovery') {
      // Settlement reports what a plain write would have thrown; the pane still needs to remount.
      sendPtyWriteUnavailable(id)
    }
    return settlement.outcome === 'accepted'
  }

  const writeChunk = (
    provider: IPtyProvider,
    id: string,
    data: string,
    verify: boolean
  ): boolean | Promise<boolean> => {
    if (!verify) {
      return provider.write(id, data) !== false
    }
    const settlement = provider.writeWithSettlement(id, data)
    return isSettledWrite(settlement)
      ? acceptedSettlement(id, settlement)
      : settlement.then((settled) => acceptedSettlement(id, settled))
  }

  const failedWrite = (id: string, error: unknown, verify: boolean): false => {
    reportUnavailablePtyWrite(id, error)
    if (verify && !isPtyWriteUnavailableError(error)) {
      throw error
    }
    return false
  }

  const writePtyProviderInput = (
    provider: IPtyProvider,
    id: string,
    data: string,
    verify = false
  ): boolean | Promise<boolean> => {
    try {
      const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(data)
      if (typeof tooLarge === 'boolean') {
        return tooLarge ? false : writePtyProviderInputWithinLimit(provider, id, data, verify)
      }
      return tooLarge
        .then((result) => {
          if (result) {
            return false
          }
          return writePtyProviderInputWithinLimit(provider, id, data, verify)
        })
        .catch((error) => {
          return failedWrite(id, error, verify)
        })
    } catch (error) {
      return failedWrite(id, error, verify)
    }
  }

  const writePtyProviderInputChunks = async (
    provider: IPtyProvider,
    id: string,
    chunks: Iterator<string>,
    firstChunk: string,
    secondChunk: string,
    verify: boolean
  ): Promise<boolean> => {
    try {
      let chunk: IteratorResult<string> = { done: false, value: firstChunk }
      let nextChunk: IteratorResult<string> = { done: false, value: secondChunk }
      let wroteChunk = false
      while (!chunk.done) {
        const accepted = writeChunk(provider, id, chunk.value, verify)
        if (!(typeof accepted === 'boolean' ? accepted : await accepted)) {
          if (wroteChunk) {
            // An accepted prefix is already in the PTY, so this is not a clean refusal.
            throw new Error('PTY write acknowledgment unavailable: partial_write')
          }
          return false
        }
        wroteChunk = true
        if (!nextChunk.done) {
          // setImmediate, not setTimeout(0): the yield exists to let abort/data callbacks run
          // between chunks, and a clamped timer tick per 16 KiB is pure latency.
          await new Promise((resolve) => setImmediate(resolve))
        }
        chunk = nextChunk
        nextChunk = chunks.next()
      }
      return true
    } catch (error) {
      return failedWrite(id, error, verify)
    }
  }

  // Why: the ack'd send path needs per-chunk settlement, not fire-and-forget
  // dispatch — only providers that expose writeAcknowledged (SSH) opt in; others
  // fall back to the plain fire-and-forget writer unchanged.
  const writePtyProviderInputAcknowledged = (
    provider: IPtyProvider,
    id: string,
    data: string
  ): boolean | Promise<boolean> => {
    const settlementWrite = (
      provider as { writeAcknowledged?: (ptyId: string, chunk: string) => Promise<boolean> }
    ).writeAcknowledged
    if (!settlementWrite) {
      return writePtyProviderInput(provider, id, data)
    }
    try {
      const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(data)
      if (typeof tooLarge === 'boolean') {
        return tooLarge ? false : writePtyProviderInputAcknowledgedChunks(settlementWrite, id, data)
      }
      return tooLarge
        .then((result) =>
          result ? false : writePtyProviderInputAcknowledgedChunks(settlementWrite, id, data)
        )
        .catch((error) => {
          reportUnavailablePtyWrite(id, error)
          return false
        })
    } catch (error) {
      reportUnavailablePtyWrite(id, error)
      return false
    }
  }

  const writePtyProviderInputAcknowledgedChunks = async (
    writeChunk: (id: string, chunk: string) => Promise<boolean>,
    id: string,
    data: string
  ): Promise<boolean> => {
    try {
      const chunks = splitTerminalInputChunks(data)
      if (chunks.length === 0) {
        return await writeChunk(id, data)
      }
      let allSettled = true
      for (const chunk of chunks) {
        if (!(await writeChunk(id, chunk))) {
          allSettled = false
        }
      }
      return allSettled
    } catch (error) {
      reportUnavailablePtyWrite(id, error)
      return false
    }
  }

  const isPtyWritePayload = (value: unknown): value is PtyWritePayload =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    (value as { id: string }).id.length > 0 &&
    typeof (value as { data?: unknown }).data === 'string'

  const isPtyViewportClaimPayload = (value: unknown): value is PtyViewportClaimPayload =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    (value as { id: string }).id.length > 0 &&
    typeof (value as { cols?: unknown }).cols === 'number' &&
    Number.isFinite((value as { cols: number }).cols) &&
    typeof (value as { rows?: unknown }).rows === 'number' &&
    Number.isFinite((value as { rows: number }).rows) &&
    (value as { cols: number }).cols > 0 &&
    (value as { rows: number }).rows > 0

  const isPtyWriteEventFromMainWindow = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    isMainWindowPtyIpcEvent(event, mainWindow)

  const noteRendererPtyInput = (args: PtyWritePayload): void => {
    lastInputAtByPty.set(args.id, performance.now())
    interactiveOutputCharsByPty.set(args.id, 0)
    runtime?.terminalRunFacts?.recordInput(args.id, args.inputKind, args.data)
    runtime?.noteRemoteDesktopHostInput(args.id, args.inputKind, args.data)
  }

  const writeAndObserveInput = (
    provider: IPtyProvider,
    args: PtyWritePayload,
    verify = false
  ): boolean | Promise<boolean> => {
    const observe = (accepted: boolean): boolean => {
      if (
        accepted &&
        args.inputKind === 'driving' &&
        ptyOwnership.get(args.id) === LOCAL_EXECUTION_HOST_ID
      ) {
        runtime?.observeClaudeTerminalEvidence?.(args.id, { kind: 'input', data: args.data })
      }
      return accepted
    }
    const result = writePtyProviderInput(provider, args.id, args.data, verify)
    return typeof result === 'boolean' ? observe(result) : result.then(observe)
  }

  const writePtyInput = (args: PtyWritePayload): boolean | Promise<boolean> => {
    // Why: mobile-presence-lock defense-in-depth — the renderer's onData guard can let one keystroke slip during the state-flip lag, so catch it server-side. See docs/mobile-presence-lock.md.
    if (runtime?.getDriver(args.id).kind === 'mobile') {
      return false
    }
    const provider = ptyOwnership.has(args.id) ? tryGetProviderForPty(args.id) : undefined
    if (!provider) {
      return false
    }
    try {
      noteRendererPtyInput(args)
      return writeAndObserveInput(provider, args)
    } catch {
      return false
    }
  }

  const writePtyInputSettled = (args: PtyWritePayload): boolean | Promise<boolean> => {
    if (!ptyOwnership.has(args.id)) {
      return false
    }
    const provider = tryGetProviderForPty(args.id)
    if (!provider?.hasPty?.(args.id)) {
      return false
    }
    noteRendererPtyInput(args)
    return writeAndObserveInput(provider, args, true)
  }

  // Why: a disposed or backpressured SSH mux can silently drop provider.write's
  // fire-and-forget notify, so this path settles over the transport instead of
  // trusting write()'s void return — kept separate from writePtyInput so the
  // fire-and-forget keystroke path never gains an await.
  const writePtyInputProvablyLive = (args: PtyWritePayload): boolean | Promise<boolean> => {
    if (runtime?.getDriver(args.id).kind === 'mobile') {
      return false
    }
    const provider = ptyOwnership.has(args.id) ? tryGetProviderForPty(args.id) : undefined
    if (!provider) {
      return false
    }
    try {
      noteRendererPtyInput(args)
      return writePtyProviderInputAcknowledged(provider, args.id, args.data)
    } catch {
      return false
    }
  }

  const writePtyInputAccepted = (args: PtyWritePayload): boolean | Promise<boolean> => {
    if (runtime?.getDriver(args.id).kind === 'mobile') {
      return false
    }
    if (args.requireWriteSettlement === true) {
      return writePtyInputSettled(args)
    }
    // Why: the ack infers Ctrl+C/Escape reached the local PTY; SSH providers are fire-and-forget relay notifications and can't truthfully acknowledge yet.
    if (ptyOwnership.get(args.id) !== LOCAL_EXECUTION_HOST_ID) {
      return false
    }
    const provider = tryGetProviderForPty(args.id)
    if (!provider?.hasPty?.(args.id)) {
      return false
    }
    try {
      noteRendererPtyInput(args)
      return writeAndObserveInput(provider, args)
    } catch {
      return false
    }
  }

  return {
    writePtyInput,
    writePtyInputAccepted,
    writePtyInputProvablyLive,
    isPtyWritePayload,
    isPtyViewportClaimPayload,
    isPtyWriteEventFromMainWindow
  }
}

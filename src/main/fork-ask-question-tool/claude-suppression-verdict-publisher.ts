import type { BrowserWindow, IpcMain } from 'electron'
import {
  setLocalClaudeSuppressionVerdictReader,
  type ClaudeSuppressionVerdict
} from '../../shared/fork-ask-question-tool/claude-suppression-verdict'
import {
  claudeAskSuppressionGateCache,
  peekClaudeAskSuppressionFlags,
  resolveClaudeAskSuppressionFlags
} from './claude-ask-suppression-gate'
import {
  buildLocalClaudeAskGateHost,
  LOCAL_CLAUDE_HOST_SETTINGS_KEYS,
  type LocalClaudeHostSettings
} from './claude-ask-suppression-local-host'

export const ASK_SUPPRESSION_VERDICT_CHANNEL = 'ask:suppressionVerdict'
export const ASK_SUPPRESSION_VERDICT_GET_CHANNEL = 'ask:suppressionVerdict:get'

type VerdictPublisherStore = {
  getSettings: () => LocalClaudeHostSettings
  onSettingsChanged?: (listener: (updates: Record<string, unknown>) => void) => () => void
}

/**
 * Makes the local AskUserQuestion suppression verdict readable from both processes.
 *
 * Main reads it straight from the gate cache. The renderer cannot probe a binary, so it gets the
 * same value pushed here — fetched once when it subscribes (the probe usually has not landed by
 * then) and again each time the answer changes, which is what turns a first launch after boot from
 * unsuppressed into suppressed without waiting for a restart.
 *
 * Only startup and a settings change publish. A probe that `peek` starts for some other host
 * concludes silently, so a future caller that peeks a host this does not warm must push it itself.
 */
export function startClaudeSuppressionVerdictPublisher(args: {
  store: VerdictPublisherStore
  ipcMain: IpcMain
  getWindows: () => readonly (BrowserWindow | null | undefined)[]
}): () => void {
  const currentHost = (): ReturnType<typeof buildLocalClaudeAskGateHost> =>
    buildLocalClaudeAskGateHost(args.store.getSettings())

  const read = (): ClaudeSuppressionVerdict => peekClaudeAskSuppressionFlags(currentHost())
  setLocalClaudeSuppressionVerdictReader(read)

  let published: ClaudeSuppressionVerdict = 'pending'
  const publish = (verdict: ClaudeSuppressionVerdict): void => {
    if (sameVerdict(published, verdict)) {
      return
    }
    published = verdict
    for (const window of args.getWindows()) {
      if (window && !window.isDestroyed()) {
        window.webContents.send(ASK_SUPPRESSION_VERDICT_CHANNEL, verdict)
      }
    }
  }

  const refresh = async (): Promise<void> => {
    const host = currentHost()
    await resolveClaudeAskSuppressionFlags(host)
    publish(peekClaudeAskSuppressionFlags(host))
  }

  args.ipcMain.handle(ASK_SUPPRESSION_VERDICT_GET_CHANNEL, () => read())

  const unsubscribe = args.store.onSettingsChanged?.((updates) => {
    if (!LOCAL_CLAUDE_HOST_SETTINGS_KEYS.some((key) => key in updates)) {
      return
    }
    // A new override or terminal shell points at a different binary, and the cache is keyed by
    // host rather than by the settings that chose it.
    claudeAskSuppressionGateCache.clear()
    published = 'pending'
    void refresh()
  })

  void refresh()

  return () => {
    setLocalClaudeSuppressionVerdictReader(null)
    args.ipcMain.removeHandler(ASK_SUPPRESSION_VERDICT_GET_CHANNEL)
    unsubscribe?.()
  }
}

function sameVerdict(a: ClaudeSuppressionVerdict, b: ClaudeSuppressionVerdict): boolean {
  if (a === b) {
    return true
  }
  if (!Array.isArray(a) || !Array.isArray(b)) {
    return false
  }
  return a.length === b.length && a.every((value, index) => value === b[index])
}
